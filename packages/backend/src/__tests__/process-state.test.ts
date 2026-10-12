import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createOpenSessions, createServerProcess, RUNTIME_IDLE_MS, suspendSessions, type OpenSessionsOptions } from "../process-state.js";
import type { App, SessionRuntime } from "../state.js";
import type { SessionSettled } from "../sessions/session-runs.js";
import { logger } from "../logger.js";

/** A runtime that records being closed; `streaming` says whether it has a run in flight. */
function fakeRuntime(streaming = false) {
  const state = { streaming, closed: false, suspended: false, paused: true };
  const runtime: SessionRuntime = {
    isStreaming: () => state.streaming, close: async () => { state.closed = true; },
    prompt: async () => ({ messageId: "m" }), steer: async () => {}, setModel: async () => {}, abort: async () => {},
    resumePendingOperation: async () => false, isPaused: () => state.paused, suspend: async () => { state.suspended = true; },
  };
  return { state, entry: { runtime, binding: "b", lastActivity: 0, retired: false, faulted: false } };
}

/** An `App`, distinguishable by `name`. */
const app = (name: string): App & { name: string } => ({
  name, node: () => { throw new Error("no node"); }, runStarted: () => {}, runSettled: async () => {},
  executeScript: async () => { throw new Error("no tools"); }, searchScript: async () => { throw new Error("no tools"); }, createTask: async () => { throw new Error("no tools"); },
});

/** A completed run's settlement report. */
const settled = (sessionId: string, runId: string): SessionSettled => ({ sessionId, runId, reportId: crypto.randomUUID(), status: "completed", metadata: { model: null, thinkingLevel: null }, tipId: null });

/** A process with no database, browsers or node socket of use. */
const newProcess = (options?: OpenSessionsOptions) =>
  createServerProcess({ db: new Database(":memory:"), broadcast: () => {}, frontendDir: "/tmp/nonexistent", nodeSocket: "/tmp/unused.sock" }, options);

describe("the process's live runtimes", () => {
  test("the idle sweep closes a runtime idle for 3 minutes, never one still streaming or used since", () => {
    let now = 0;
    const sessions = createOpenSessions({ now: () => now });
    const idle = fakeRuntime(), streaming = fakeRuntime(true), recent = fakeRuntime();
    sessions.live.set("idle", idle.entry);
    sessions.live.set("streaming", streaming.entry);
    sessions.live.set("recent", { ...recent.entry, lastActivity: 60_000 });

    now = RUNTIME_IDLE_MS - 1;
    sessions.sweep();
    expect([...sessions.live.keys()]).toEqual(["idle", "streaming", "recent"]);

    now = RUNTIME_IDLE_MS;
    sessions.sweep();
    expect([...sessions.live.keys()]).toEqual(["streaming", "recent"]);
    expect([idle.state.closed, streaming.state.closed, recent.state.closed]).toEqual([true, false, false]);
  });

  test("a new app closes the idle runtimes earlier apps built at once, and the running ones once they are idle", async () => {
    const serverProcess = newProcess();
    const { sessions } = serverProcess;
    serverProcess.registerApp(app("first"));
    const idle = fakeRuntime(), running = fakeRuntime(true);
    sessions.live.set("idle", { ...idle.entry, lastActivity: Date.now() });
    sessions.live.set("running", { ...running.entry, lastActivity: Date.now() });

    serverProcess.registerApp(app("second"));
    expect(idle.state.closed).toBe(true);
    expect(sessions.live.get("running")).toMatchObject({ retired: true });
    sessions.sweep();
    expect(running.state.closed).toBe(false);

    running.state.streaming = false;
    sessions.sweep();
    expect(running.state.closed).toBe(true);
    expect(sessions.live.size).toBe(0);
  });

  test("the current app is a plain property: each registered app until its stop, and none in the gap between apps", () => {
    const serverProcess = newProcess();
    expect(serverProcess.app).toBeUndefined();
    const unregister = serverProcess.registerApp(app("first"));
    expect(serverProcess.app).toMatchObject({ name: "first" });

    unregister();
    expect(serverProcess.app).toBeUndefined();
    const unregisterSecond = serverProcess.registerApp(app("second"));
    // A stale unregistration leaves the current app alone.
    unregister();
    expect(serverProcess.app).toMatchObject({ name: "second" });
    unregisterSecond();
    expect(serverProcess.app).toBeUndefined();
  });

  test("run reports made in the gap are kept, and delivered in order to the next app as it registers, before any made after", async () => {
    const serverProcess = newProcess();
    const delivered: string[] = [];
    const recording = (name: string): App => ({
      ...app(name),
      runStarted: (sessionId, runId) => { delivered.push(`${name} ${sessionId} started ${runId}`); },
      runSettled: async ({ sessionId, runId }) => { await Bun.sleep(5); delivered.push(`${name} ${sessionId} settled ${runId}`); },
    });

    serverProcess.registerApp(recording("first"))();
    // Each resolves at once: queued, not delivered.
    await serverProcess.reportRun("a", { kind: "started", runId: "r1" });
    await serverProcess.reportRun("a", { kind: "settled", settled: settled("a", "r1") });
    await serverProcess.reportRun("b", { kind: "started", runId: "r2" });
    expect(delivered).toEqual([]);

    serverProcess.registerApp(recording("second"));
    const after = serverProcess.reportRun("a", { kind: "started", runId: "r3" });
    await after;
    expect(delivered.filter(line => line.includes(" a "))).toEqual(["second a started r1", "second a settled r1", "second a started r3"]);
    expect(delivered).toContain("second b started r2");
  });

  test("a run report delivered with an app resolves once the app applied it; a failing one is logged and the next delivered", async () => {
    const serverProcess = newProcess();
    const delivered: string[] = [];
    let failing = true;
    serverProcess.registerApp({
      ...app("only"),
      runStarted: (_sessionId, runId) => {
        if (failing) { failing = false; throw new Error("broken"); }
        delivered.push(runId);
      },
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await serverProcess.reportRun("a", { kind: "started", runId: "lost" });
      await serverProcess.reportRun("a", { kind: "started", runId: "kept" });
      expect(delivered).toEqual(["kept"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  test("shutdown closes the pause gate, waits for every runtime to be paused, then suspends them all without closing them", async () => {
    const sessions = createOpenSessions();
    const held = fakeRuntime(true), busy = fakeRuntime(true);
    busy.state.paused = false;
    sessions.live.set("held", held.entry);
    sessions.live.set("busy", busy.entry);
    // The busy one reaches a pause point a little later.
    setTimeout(() => { busy.state.paused = true; }, 50);
    const started = Date.now();
    await suspendSessions(sessions, { pauseMs: 2_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sessions.pauseGate.closed).toBe(true);
    expect([held.state, busy.state].map(({ suspended, closed }) => ({ suspended, closed }))).toEqual([{ suspended: true, closed: false }, { suspended: true, closed: false }]);
    expect(sessions.live.size).toBe(0);
  });

  test("shutdown suspends a runtime still busy at its bound anyway", async () => {
    const sessions = createOpenSessions();
    const stuck = fakeRuntime(true);
    stuck.state.paused = false;
    sessions.live.set("stuck", stuck.entry);
    await suspendSessions(sessions, { pauseMs: 30 });
    expect(stuck.state.suspended).toBe(true);
  });
});

