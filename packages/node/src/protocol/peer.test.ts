import { test, expect } from "bun:test";
import { createRpcPeer, RpcFailure } from "./peer.js";
import { statusResult } from "./schema.js";
import { z } from "zod";

function pair() {
  const left: { receive(data: string): void; close(): void }[] = [];
  const right: { receive(data: string): void; close(): void }[] = [];
  const a = createRpcPeer({ send: data => queueMicrotask(() => right[0]!.receive(data)), close: () => {} }, {});
  const b = createRpcPeer({ send: data => queueMicrotask(() => left[0]!.receive(data)), close: () => {} }, {
    "node.status": { params: z.object({ sessionId: z.string() }), result: statusResult, handle: async () => ({ provisioned: true }) },
  });
  left.push(a); right.push(b);
  return { a, b };
}

test("correlates concurrent JSON-RPC calls and validates results", async () => {
  const { a } = pair();
  const results = await Promise.all([
    a.call("node.status", { sessionId: "a" }, statusResult),
    a.call("node.status", { sessionId: "b" }, statusResult),
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
  await expect(peer.call("node.provision", {}, statusResult)).rejects.toMatchObject({ outcome: "unknown" });
});

test("oversize inbound frame closes the peer without dispatch", () => {
  const { a } = pair();
  a.receive("x".repeat(1_048_577));
  expect(() => a.call("node.status", {}, statusResult)).toThrow(RpcFailure);
});
