import { describe, expect, test } from "bun:test";
import { createProcessSessions, NO_LOAD_SERVING, RUNTIME_IDLE_MS } from "../process-state.js";
import type { LiveRuntime, LoadServices } from "../state.js";

/** A runtime that records being closed; `streaming` says whether it has a run in flight. */
function fakeRuntime(streaming = false) {
  const state = { streaming, closed: false };
  const runtime: LiveRuntime = {
    isStreaming: () => state.streaming, close: async () => { state.closed = true; },
    prompt: async () => ({ messageId: "m" }), steer: async () => {}, setModel: async () => {}, abort: async () => {},
    resumePendingOperation: async () => false, isPaused: () => true, suspend: async () => {},
  };
  return { state, entry: { runtime, binding: "b", lastActivity: 0, retired: false, faulted: false } };
}

/** A load's services, distinguishable by `name`. */
const load = (name: string): LoadServices & { name: string } => ({
  name, node: () => { throw new Error("no node"); }, credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
  runStarted: () => {}, runSettled: () => {}, toolCalls: () => { throw new Error("no tools"); }, attachment: () => null, storeAttachment: () => {},
});

describe("the process's live runtimes", () => {
  test("the idle sweep closes a runtime idle for 3 minutes, never one still streaming or used since", () => {
    let now = 0;
    const sessions = createProcessSessions({ now: () => now });
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
    const sessions = createProcessSessions();
    sessions.serve(load("first"));
    const idle = fakeRuntime(), running = fakeRuntime(true);
    sessions.live.set("idle", { ...idle.entry, lastActivity: Date.now() });
    sessions.live.set("running", { ...running.entry, lastActivity: Date.now() });

    sessions.serve(load("second"));
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
    const sessions = createProcessSessions({ loadWaitMs: 50 });
    const release = sessions.serve(load("first"));
    expect(await sessions.load()).toMatchObject({ name: "first" });

    release();
    const waiting = sessions.load();
    await Bun.sleep(10);
    sessions.serve(load("second"));
    expect(await waiting).toMatchObject({ name: "second" });

    sessions.serve(load("third"))();
    expect(await sessions.load().catch((error: Error) => error.name)).toBe(NO_LOAD_SERVING);
    const aborted = new AbortController();
    const cut = sessions.load(aborted.signal).catch((error: unknown) => error);
    aborted.abort(new Error("stopped"));
    expect(await cut).toMatchObject({ message: "stopped" });
  });
});
