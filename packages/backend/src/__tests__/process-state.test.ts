import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createOpenSessions, createServerProcess, NO_APP, RUNTIME_IDLE_MS, suspendSessions, type ServerProcessOptions } from "../process-state.js";
import type { App, SessionRuntime } from "../state.js";

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
  name, hub: { publicKey: () => null, refusal: nodeId => `Node not found: ${nodeId}`, helloBuild: async () => ({ kind: "serve", status: "current" }), publish: () => {} },
  runStarted: () => {}, runSettled: async () => {},
  executeScript: async () => { throw new Error("no tools"); }, searchScript: async () => { throw new Error("no tools"); }, createTask: async () => { throw new Error("no tools"); },
});

/** A process with no database or browsers of use. */
const newProcess = (options?: ServerProcessOptions) =>
  createServerProcess({ db: new Database(":memory:"), broadcast: () => {}, frontendDir: "/tmp/nonexistent" }, options);

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

  test("a runtime reaches the current app; during a reload it waits for the next app, for a bounded time", async () => {
    const serverProcess = newProcess({ appWaitMs: 50 });
    const unregister = serverProcess.registerApp(app("first"));
    expect(await serverProcess.app()).toMatchObject({ name: "first" });

    unregister();
    const waiting = serverProcess.app();
    await Bun.sleep(10);
    serverProcess.registerApp(app("second"));
    expect(await waiting).toMatchObject({ name: "second" });

    serverProcess.registerApp(app("third"))();
    expect(await serverProcess.app().catch((error: Error) => error.name)).toBe(NO_APP);
    const aborted = new AbortController();
    const cut = serverProcess.app(aborted.signal).catch((error: unknown) => error);
    aborted.abort(new Error("stopped"));
    expect(await cut).toMatchObject({ message: "stopped" });
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

