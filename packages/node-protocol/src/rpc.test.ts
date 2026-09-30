import { test, expect, spyOn } from "bun:test";
import { createRpcPeer, FRAME_TOO_LARGE, NotConnected, RpcFailure, INTERNAL_ERROR, METHOD_NOT_FOUND } from "./rpc.js";
import { APPLICATION_ERROR } from "./errors.js";
import { z } from "zod";

/** An ad-hoc result schema: the peer is method-agnostic. */
const statusResult = z.strictObject({ ready: z.boolean() });

function pair() {
  const left: { receive(data: string): void; close(): void }[] = [];
  const right: { receive(data: string): void; close(): void }[] = [];
  const a = createRpcPeer({ send: data => queueMicrotask(() => right[0]!.receive(data)), close: () => {} }, {});
  const b = createRpcPeer({ send: data => queueMicrotask(() => left[0]!.receive(data)), close: () => {} }, {
    "test.status": { params: z.object({ sessionId: z.string() }), result: statusResult, handle: async () => ({ ready: true }) },
  });
  left.push(a); right.push(b);
  return { a, b };
}

test("correlates concurrent JSON-RPC calls and validates results", async () => {
  const { a } = pair();
  const results = await Promise.all([
    a.call("test.status", { sessionId: "a" }, statusResult),
    a.call("test.status", { sessionId: "b" }, statusResult),
  ]);
  expect(results).toEqual([{ ready: true }, { ready: true }]);
});

test("unknown method returns JSON-RPC method-not-found and close leaves outcome unknown", async () => {
  const { a } = pair();
  await expect(a.call("missing", {}, statusResult)).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
  const pending = a.call("never", {}, statusResult);
  a.close();
  await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
  // A call made once the peer is closed is never sent, so it may be sent again elsewhere.
  await expect(a.call("later", {}, statusResult)).rejects.toBeInstanceOf(NotConnected);
});

test("a send failure is an unknown outcome, never permission to retry a mutating call", async () => {
  const peer = createRpcPeer({ send: () => { throw new Error("socket dropped"); }, close: () => {} }, {});
  await expect(peer.call("test.status", {}, statusResult)).rejects.toMatchObject({ outcome: "unknown" });
});

test("the default frame cap rejects an oversized outbound call and closes on an oversized inbound frame", async () => {
  const sent: string[] = [];
  const outbound = createRpcPeer({ send: data => sent.push(data), close: () => {} }, {});
  await expect(outbound.call("test.status", { pad: "x".repeat(1_048_576) }, statusResult)).rejects.toThrow("Frame exceeds 1048576 bytes");
  expect(sent).toEqual([]);
  const { a } = pair();
  a.receive("x".repeat(1_048_577));
  expect(() => a.call("test.status", {}, statusResult)).toThrow(RpcFailure);
});

function failing(data: unknown, message = "rejected") {
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => queueMicrotask(() => b.receive(frame)), close: () => {} }, {});
  const b = createRpcPeer({ send: frame => queueMicrotask(() => left[0]!.receive(frame)), close: () => {} }, {
    "test.status": { params: z.unknown(), result: statusResult, handle: async () => { throw new RpcFailure(APPLICATION_ERROR, message, undefined, data); } },
  });
  left.push(a);
  return a;
}
const errorData = z.strictObject({ code: z.enum(["not_found"]), message: z.string().max(64), retryable: z.boolean() });

test("error data round-trips when it matches the caller's schema and is dropped without one", async () => {
  const data = { code: "not_found", message: "gone", retryable: false };
  await expect(failing(data).call("test.status", {}, statusResult, { errorData })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "rejected", data });
  const untyped = await failing(data).call("test.status", {}, statusResult).then(() => { throw new Error("resolved"); }, (error: RpcFailure) => error);
  expect(untyped).toMatchObject({ code: APPLICATION_ERROR });
  expect(untyped.data).toBeUndefined();
});

test("malformed or oversized error data from the remote is an invalid response and closes the peer", async () => {
  const bad = [
    { code: APPLICATION_ERROR, message: "x", data: { code: "bogus", message: "x", retryable: false } },
    { code: APPLICATION_ERROR, message: "x", data: { code: "not_found", message: "x", retryable: false, pad: "x".repeat(10_000) } },
    { code: APPLICATION_ERROR, message: "x".repeat(2049) },
  ];
  for (const error of bad) {
    const peer = createRpcPeer({ send: frame => queueMicrotask(() => peer.receive(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(frame).id, error }))), close: () => {} }, {});
    const rejected = await peer.call("test.status", {}, statusResult, { errorData }).then(() => { throw new Error("resolved"); }, (failure: RpcFailure) => failure);
    expect(rejected).toMatchObject({ code: INTERNAL_ERROR, message: "Invalid error response" });
    expect(rejected.outcome).toBeUndefined();
    expect(() => peer.call("test.status", {}, statusResult)).toThrow("Connection closed");
  }
});

test("a sender replaces oversized error data with a plain internal error", async () => {
  await expect(failing({ pad: "x".repeat(10_000) }).call("test.status", {}, statusResult, { errorData })).rejects.toMatchObject({ code: INTERNAL_ERROR, message: "Internal error" });
});

test("a sender truncates long error messages instead of emitting an invalid response", async () => {
  await expect(failing(undefined, "x".repeat(5000)).call("test.status", {}, statusResult)).rejects.toMatchObject({ message: "x".repeat(2048) });
});

test("a timed-out call has an unknown outcome and its late reply is ignored", async () => {
  let release!: () => void;
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => queueMicrotask(() => b.receive(frame)), close: () => {} }, {});
  const b = createRpcPeer({ send: frame => queueMicrotask(() => left[0]!.receive(frame)), close: () => {} }, {
    "test.status": { params: z.unknown(), result: statusResult, handle: () => new Promise(resolve => { release = () => resolve({ ready: true }); }) },
  });
  left.push(a);
  await expect(a.call("test.status", {}, statusResult, { timeoutMs: 5 })).rejects.toMatchObject({ outcome: "unknown" });
  release();
  await Bun.sleep(1);
  const next = a.call("test.status", {}, statusResult);
  await Bun.sleep(1);
  release();
  await expect(next).resolves.toEqual({ ready: true });
});

test("an aborted call stops waiting with an unknown outcome, and a pre-aborted call is never sent", async () => {
  let release!: () => void;
  let received = 0;
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => queueMicrotask(() => b.receive(frame)), close: () => {} }, {});
  const b = createRpcPeer({ send: frame => queueMicrotask(() => left[0]!.receive(frame)), close: () => {} }, {
    "test.status": { params: z.unknown(), result: statusResult, handle: () => { received++; return new Promise(resolve => { release = () => resolve({ ready: true }); }); } },
  });
  left.push(a);
  const controller = new AbortController();
  const call = a.call("test.status", {}, statusResult, { signal: controller.signal });
  await Bun.sleep(1);
  controller.abort();
  await expect(call).rejects.toMatchObject({ message: "Call aborted; outcome unknown", outcome: "unknown" });
  release(); // late reply is dropped, not a protocol violation
  await Bun.sleep(1);
  const failure = await a.call("test.status", {}, statusResult, { signal: controller.signal }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "unavailable", outcome: undefined });
  expect(received).toBe(1);
  const next = a.call("test.status", {}, statusResult);
  await Bun.sleep(1);
  release();
  await expect(next).resolves.toEqual({ ready: true });
});

function notifying(notify: (params: unknown) => void | Promise<void>) {
  const toB: string[] = [];
  const toA: string[] = [];
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => { toB.push(frame); queueMicrotask(() => b.receive(frame)); }, close: () => {} }, {}, { maxFrameBytes: 4096 });
  const b = createRpcPeer({ send: frame => { toA.push(frame); queueMicrotask(() => left[0]!.receive(frame)); }, close: () => {} }, {
    "session.event": { params: z.strictObject({ seq: z.number().int() }), notify },
    "test.status": { params: z.unknown(), result: statusResult, handle: async () => ({ ready: true }) },
  });
  left.push(a);
  return { a, b, toA, toB };
}

test("notifications carry no id, reach their handler in order and are never answered", async () => {
  const received: unknown[] = [];
  const { a, toA, toB } = notifying(params => { received.push(params); });
  expect(a.notify("session.event", { seq: 1 })).toBe(true);
  expect(a.notify("session.event", { seq: 2 })).toBe(true);
  await Bun.sleep(1);
  expect(received).toEqual([{ seq: 1 }, { seq: 2 }]);
  expect(JSON.parse(toB[0]!)).toEqual({ jsonrpc: "2.0", method: "session.event", params: { seq: 1 } });
  expect(toA).toEqual([]);
});

test("invalid, unknown or failing notifications are dropped without a reply or closing the peer", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { a, toA } = notifying(() => { throw new Error("subscriber failed"); });
    a.notify("session.event", { seq: "one" });
    a.notify("missing", {});
    a.notify("test.status", {});
    a.notify("session.event", { seq: 1 });
    await Bun.sleep(1);
    expect(toA).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
    await expect(a.call("test.status", {}, statusResult)).resolves.toEqual({ ready: true });
    await expect(a.call("session.event", { seq: 1 }, statusResult)).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
  } finally { warn.mockRestore(); }
});

test("an unsendable notification is dropped locally; the connection stays open", async () => {
  const { a } = notifying(() => {});
  expect(a.notify("session.event", { seq: 1, pad: "x".repeat(5000) })).toBe(false);
  await expect(a.call("test.status", {}, statusResult)).resolves.toEqual({ ready: true });
  a.close();
  expect(a.notify("session.event", { seq: 2 })).toBe(false);
});

/** Manual timers: `tick()` runs every interval callback once. */
function manualTimers() {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      setTimeout: (callback: () => void) => { timeouts.set(++next, callback); return next; },
      clearTimeout: (handle: unknown) => { timeouts.delete(Number(handle)); },
      setInterval: (callback: () => void) => { intervals.set(++next, callback); return next; },
      clearInterval: (handle: unknown) => { intervals.delete(Number(handle)); },
    },
    tick: () => { for (const callback of Array.from(intervals.values())) callback(); },
    fire: () => { const pending = [...timeouts.values()]; timeouts.clear(); for (const callback of pending) callback(); },
    intervals: () => intervals.size,
  };
}

test("heartbeat pings every interval without reply, counts any received frame as heard, and closes after the missed limit", async () => {
  const clock = manualTimers();
  const sent: string[] = [];
  let socketClosed = false;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const peer = createRpcPeer({ send: data => sent.push(data), close: () => { socketClosed = true; } }, {}, { heartbeat: { intervalMs: 10, missedIntervals: 2 }, timers: clock.timers });
  const pending = peer.call("test.status", {}, statusResult);
  clock.tick();
  expect(sent.at(-1)).toBe('{"jsonrpc":"2.0","method":"node.ping","params":{}}');
  // A ping from the other side (or any frame) keeps the link up and is never dispatched or answered.
  peer.receive('{"jsonrpc":"2.0","method":"node.ping","params":{}}');
  clock.tick();
  clock.tick();
  expect(socketClosed).toBe(false);
  expect(warn).not.toHaveBeenCalled();
  clock.tick();
  expect(socketClosed).toBe(true);
  expect(clock.intervals()).toBe(0);
  await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
  expect(sent.filter(frame => frame.includes("node.ping"))).toHaveLength(3);
  warn.mockRestore();
});

test("an oversized outbound call fails alone with a terminal code and leaves the connection open", async () => {
  const { a } = pair();
  await expect(a.call("test.status", { pad: "x".repeat(1_048_576) }, statusResult)).rejects.toMatchObject({ code: FRAME_TOO_LARGE });
  expect(await a.call("test.status", { sessionId: "a" }, statusResult)).toEqual({ ready: true });
});
