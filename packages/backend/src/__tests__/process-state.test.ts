import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createOpenSessions, createServerProcess, RUNTIME_IDLE_MS, suspendSessions, type OpenSessionsOptions } from "../process-state.js";
import type { App, SessionRuntime } from "../state.js";

/** A runtime that records being closed; `streaming` says whether it has a run in flight. */
function fakeRuntime(streaming = false) {
  const state = { streaming, closed: false, suspended: false, paused: true };
  const runtime: SessionRuntime = {
    isStreaming: () => state.streaming, isBusy: () => state.streaming, whenIdle: async () => {}, close: async () => { state.closed = true; },
    prompt: async () => ({ messageId: "m" }), steer: async () => {}, setModel: async () => {}, compact: async () => {}, abort: async () => {},
    resumePendingOperation: async () => false, isPaused: () => state.paused, suspend: async () => { state.suspended = true; },
  };
  return { state, entry: { runtime, binding: "b", lastActivity: 0, retired: false, faulted: false } };
}

/** An `App`, distinguishable by `name`. */
const app = (name: string): App & { name: string } => ({
  name, code: Symbol(name), node: () => { throw new Error("no node"); },
  executeScript: async () => { throw new Error("no tools"); }, searchScript: async () => { throw new Error("no tools"); }, createTask: async () => { throw new Error("no tools"); },
});

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

