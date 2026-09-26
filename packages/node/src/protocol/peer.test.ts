import { test, expect, spyOn } from "bun:test";
import { createRpcPeer, RpcFailure } from "./peer.js";
import { statusResult } from "./schema.js";
import { z } from "zod";

function pair() {
  const left: { receive(data: string): void; close(): void }[] = [];
  const right: { receive(data: string): void; close(): void }[] = [];
  const a = createRpcPeer({ send: data => queueMicrotask(() => right[0]!.receive(data)), close: () => {} }, {});
  const b = createRpcPeer({ send: data => queueMicrotask(() => left[0]!.receive(data)), close: () => {} }, {
    "session.status": { params: z.object({ sessionId: z.string() }), result: statusResult, handle: async () => ({ provisioned: true }) },
  });
  left.push(a); right.push(b);
  return { a, b };
}

test("correlates concurrent JSON-RPC calls and validates results", async () => {
  const { a } = pair();
  const results = await Promise.all([
    a.call("session.status", { sessionId: "a" }, statusResult),
    a.call("session.status", { sessionId: "b" }, statusResult),
  ]);
  expect(results).toEqual([{ provisioned: true }, { provisioned: true }]);
});

test("unknown method returns JSON-RPC method-not-found and close leaves outcome unknown", async () => {
  const { a } = pair();
  await expect(a.call("missing", {}, statusResult)).rejects.toMatchObject({ code: -32601 });
  const pending = a.call("never", {}, statusResult);
  a.close();
  await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
});

test("a send failure is an unknown outcome, never permission to retry a mutating call", async () => {
  const peer = createRpcPeer({ send: () => { throw new Error("socket dropped"); }, close: () => {} }, {});
  await expect(peer.call("session.provision", {}, statusResult)).rejects.toMatchObject({ outcome: "unknown" });
});

test("the default frame cap rejects an oversized outbound call and closes on an oversized inbound frame", async () => {
  const sent: string[] = [];
  const outbound = createRpcPeer({ send: data => sent.push(data), close: () => {} }, {});
  await expect(outbound.call("session.status", { pad: "x".repeat(1_048_576) }, statusResult)).rejects.toThrow("Frame exceeds 1048576 bytes");
  expect(sent).toEqual([]);
  const { a } = pair();
  a.receive("x".repeat(1_048_577));
  expect(() => a.call("session.status", {}, statusResult)).toThrow(RpcFailure);
});

function failing(data: unknown, message = "rejected") {
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => queueMicrotask(() => b.receive(frame)), close: () => {} }, {});
  const b = createRpcPeer({ send: frame => queueMicrotask(() => left[0]!.receive(frame)), close: () => {} }, {
    "session.status": { params: z.unknown(), result: statusResult, handle: async () => { throw new RpcFailure(-32000, message, undefined, data); } },
  });
  left.push(a);
  return a;
}
const errorData = z.strictObject({ code: z.enum(["not_found"]), message: z.string().max(64), retryable: z.boolean() });

test("error data round-trips when it matches the caller's schema and is dropped without one", async () => {
  const data = { code: "not_found", message: "gone", retryable: false };
  await expect(failing(data).call("session.status", {}, statusResult, { errorData })).rejects.toMatchObject({ code: -32000, message: "rejected", data });
  const untyped = await failing(data).call("session.status", {}, statusResult).then(() => { throw new Error("resolved"); }, (error: RpcFailure) => error);
  expect(untyped).toMatchObject({ code: -32000 });
  expect(untyped.data).toBeUndefined();
});

test("malformed or oversized error data from the remote is an invalid response and closes the peer", async () => {
  const bad = [
    { code: -32000, message: "x", data: { code: "bogus", message: "x", retryable: false } },
    { code: -32000, message: "x", data: { code: "not_found", message: "x", retryable: false, pad: "x".repeat(10_000) } },
    { code: -32000, message: "x".repeat(2049) },
  ];
  for (const error of bad) {
    const peer = createRpcPeer({ send: frame => queueMicrotask(() => peer.receive(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(frame).id, error }))), close: () => {} }, {});
    const rejected = await peer.call("session.status", {}, statusResult, { errorData }).then(() => { throw new Error("resolved"); }, (failure: RpcFailure) => failure);
    expect(rejected).toMatchObject({ code: -32603, message: "Invalid error response" });
    expect(rejected.outcome).toBeUndefined();
    expect(() => peer.call("session.status", {}, statusResult)).toThrow("Connection closed");
  }
});

test("a sender replaces oversized error data with a plain internal error", async () => {
  await expect(failing({ pad: "x".repeat(10_000) }).call("session.status", {}, statusResult, { errorData })).rejects.toMatchObject({ code: -32603, message: "Internal error" });
});

test("a sender truncates long error messages instead of emitting an invalid response", async () => {
  await expect(failing(undefined, "x".repeat(5000)).call("session.status", {}, statusResult)).rejects.toMatchObject({ message: "x".repeat(2048) });
});

test("a timed-out call has an unknown outcome and its late reply is ignored", async () => {
  let release!: () => void;
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => queueMicrotask(() => b.receive(frame)), close: () => {} }, {});
  const b = createRpcPeer({ send: frame => queueMicrotask(() => left[0]!.receive(frame)), close: () => {} }, {
    "session.status": { params: z.unknown(), result: statusResult, handle: () => new Promise(resolve => { release = () => resolve({ provisioned: true }); }) },
  });
  left.push(a);
  await expect(a.call("session.status", {}, statusResult, { timeoutMs: 5 })).rejects.toMatchObject({ outcome: "unknown" });
  release();
  await Bun.sleep(1);
  const next = a.call("session.status", {}, statusResult);
  await Bun.sleep(1);
  release();
  await expect(next).resolves.toEqual({ provisioned: true });
});

test("an aborted call stops waiting with an unknown outcome, and a pre-aborted call is never sent", async () => {
  let release!: () => void;
  let received = 0;
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => queueMicrotask(() => b.receive(frame)), close: () => {} }, {});
  const b = createRpcPeer({ send: frame => queueMicrotask(() => left[0]!.receive(frame)), close: () => {} }, {
    "session.status": { params: z.unknown(), result: statusResult, handle: () => { received++; return new Promise(resolve => { release = () => resolve({ provisioned: true }); }); } },
  });
  left.push(a);
  const controller = new AbortController();
  const call = a.call("session.status", {}, statusResult, { signal: controller.signal });
  await Bun.sleep(1);
  controller.abort();
  await expect(call).rejects.toMatchObject({ message: "Call aborted; outcome unknown", outcome: "unknown" });
  release(); // late reply is dropped, not a protocol violation
  await Bun.sleep(1);
  const failure = await a.call("session.status", {}, statusResult, { signal: controller.signal }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "unavailable", outcome: undefined });
  expect(received).toBe(1);
  const next = a.call("session.status", {}, statusResult);
  await Bun.sleep(1);
  release();
  await expect(next).resolves.toEqual({ provisioned: true });
});

function notifying(notify: (params: unknown) => void | Promise<void>) {
  const toB: string[] = [];
  const toA: string[] = [];
  const left: { receive(data: string): void }[] = [];
  const a = createRpcPeer({ send: frame => { toB.push(frame); queueMicrotask(() => b.receive(frame)); }, close: () => {} }, {}, { maxFrameBytes: 4096 });
  const b = createRpcPeer({ send: frame => { toA.push(frame); queueMicrotask(() => left[0]!.receive(frame)); }, close: () => {} }, {
    "session.event": { params: z.strictObject({ seq: z.number().int() }), notify },
    "session.status": { params: z.unknown(), result: statusResult, handle: async () => ({ provisioned: true }) },
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
    a.notify("session.status", {});
    a.notify("session.event", { seq: 1 });
    await Bun.sleep(1);
    expect(toA).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
    await expect(a.call("session.status", {}, statusResult)).resolves.toEqual({ provisioned: true });
    await expect(a.call("session.event", { seq: 1 }, statusResult)).rejects.toMatchObject({ code: -32601 });
  } finally { warn.mockRestore(); }
});

test("an unsendable notification is dropped locally; the connection stays open", async () => {
  const { a } = notifying(() => {});
  expect(a.notify("session.event", { seq: 1, pad: "x".repeat(5000) })).toBe(false);
  await expect(a.call("session.status", {}, statusResult)).resolves.toEqual({ provisioned: true });
  a.close();
  expect(a.notify("session.event", { seq: 2 })).toBe(false);
});
