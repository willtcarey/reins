import { describe, expect, test } from "bun:test";
import { createOpenSessions, NO_SERVER, RUNTIME_IDLE_MS, suspendSessions } from "../process-state.js";
import type { Server, SessionRuntime } from "../state.js";

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

/** A load's `Server`, distinguishable by `name`. */
const server = (name: string): Server & { name: string } => ({
  name, node: () => { throw new Error("no node"); }, credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
  runStarted: () => {}, runSettled: async () => {}, toolCalls: () => { throw new Error("no tools"); }, attachment: () => null, storeAttachment: () => {},
});

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

  test("a new load closes the idle runtimes earlier loads built at once, and the running ones once they are idle", async () => {
    const sessions = createOpenSessions();
    sessions.serve(server("first"));
    const idle = fakeRuntime(), running = fakeRuntime(true);
    sessions.live.set("idle", { ...idle.entry, lastActivity: Date.now() });
    sessions.live.set("running", { ...running.entry, lastActivity: Date.now() });

    sessions.serve(server("second"));
    expect(idle.state.closed).toBe(true);
    expect(sessions.live.get("running")).toMatchObject({ retired: true });
    sessions.sweep();
    expect(running.state.closed).toBe(false);

    running.state.streaming = false;
    sessions.sweep();
    expect(running.state.closed).toBe(true);
    expect(sessions.live.size).toBe(0);
  });

  test("a runtime reaches the load serving now; during a reload it waits for the next load, for a bounded time", async () => {
    const sessions = createOpenSessions({ serverWaitMs: 50 });
    const release = sessions.serve(server("first"));
    expect(await sessions.server()).toMatchObject({ name: "first" });

    release();
    const waiting = sessions.server();
    await Bun.sleep(10);
    sessions.serve(server("second"));
    expect(await waiting).toMatchObject({ name: "second" });

    sessions.serve(server("third"))();
    expect(await sessions.server().catch((error: Error) => error.name)).toBe(NO_SERVER);
    const aborted = new AbortController();
    const cut = sessions.server(aborted.signal).catch((error: unknown) => error);
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
