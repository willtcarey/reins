import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startNode } from "./node.js";
import { openNodeDb } from "./storage.js";
import { connectLocalNode } from "./local-link.js";
import { createRpcPeer, HELLO_TIMEOUT_MS, ndjsonSocketHandler, protocolVersion, readyResult, type NdjsonSocket } from "@reins/node-protocol";

/** Records timeouts (with their delay) for the test to fire; intervals never fire. */
function recordingTimers() {
  const timeouts = new Map<number, { ms: number; callback: () => void }>();
  let next = 0;
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => { timeouts.set(++next, { ms, callback }); return next; },
      clearTimeout: (handle: unknown) => { timeouts.delete(Number(handle)); },
      setInterval: () => ++next,
      clearInterval: () => {},
    },
    /** Waits for exactly one pending timeout with a delay matching `match`, then runs it. */
    async fire(match: (ms: number) => boolean): Promise<number> {
      for (let i = 0; i < 400; i++) {
        const found = [...timeouts].find(([, timeout]) => match(timeout.ms));
        if (found) { timeouts.delete(found[0]); found[1].callback(); return found[1].ms; }
        await Bun.sleep(2);
      }
      throw new Error(`No timeout scheduled; pending: ${[...timeouts.values()].map(timeout => timeout.ms).join(", ")}`);
    },
    pending: () => [...timeouts.values()].map(timeout => timeout.ms),
  };
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(2); expect(condition()).toBe(true); };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reins-local-link-"));
  const nodeDb = openNodeDb(":memory:");
  const node = startNode(nodeDb);
  return { path: join(dir, "node.sock"), node, async dispose() { await node.shutdown(); nodeDb.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A server that answers `node.hello` (or, silent, never reads anything) and keeps its connections. */
function listen(path: string, silent = false) {
  const connections: NdjsonSocket[] = [];
  const listener = Bun.listen({ unix: path, socket: ndjsonSocketHandler(1024 * 1024, wire => {
    connections.push(wire);
    if (silent) return;
    const peer = createRpcPeer(wire, {
      "node.hello": { params: z.unknown(), result: readyResult, handle: async () => ({ version: protocolVersion, capabilities: [], epoch: crypto.randomUUID() }) },
    });
    wire.onmessage = peer.receive; wire.onclose = peer.close;
  }) });
  return { connections, listener };
}

test("redials with capped exponential backoff and jitter, resets the backoff once a connection negotiates, and stops cleanly", async () => {
  const { path, node, dispose } = fixture();
  const clock = recordingTimers();
  let jitter = 1;
  const client = connectLocalNode(node, { path, timers: clock.timers, random: () => jitter });
  let server: ReturnType<typeof listen> | undefined;
  try {
    // Nothing listens: every dial fails and the ceiling doubles from 100ms up to the 5s cap.
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(await clock.fire(() => true));
    // Equal jitter: a delay is uniformly random in [ceiling/2, ceiling] (drawn when it is scheduled).
    jitter = 0;
    delays.push(await clock.fire(() => true));
    expect(delays).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000]);
    server = listen(path);
    expect(await clock.fire(() => true)).toBe(2500);
    await until(() => server!.connections.length === 1);
    // Negotiated: once the server closes it, the next redial starts from the initial delay again.
    await Bun.sleep(20);
    server.connections[0]!.close();
    expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(50);
    await until(() => server!.connections.length === 2);
    client.stop();
    await until(() => server!.connections[1]!.closed);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
  } finally { client.stop(); server?.listener.stop(true); await dispose(); }
});

test("the node closes a connection whose server never answers node.hello, then redials", async () => {
  const { path, node, dispose } = fixture();
  const clock = recordingTimers();
  const server = listen(path, true);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const client = connectLocalNode(node, { path, timers: clock.timers, random: () => 1 });
  try {
    await until(() => server.connections.length === 1);
    expect(await clock.fire(ms => ms === HELLO_TIMEOUT_MS)).toBe(HELLO_TIMEOUT_MS);
    await until(() => server.connections[0]!.closed);
    expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(100);
    await until(() => server.connections.length === 2);
    expect(warn.mock.calls.some(([message]) => String(message).includes("negotiation timed out"))).toBe(true);
  } finally { warn.mockRestore(); client.stop(); server.listener.stop(true); await dispose(); }
});
