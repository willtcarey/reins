import { test, expect } from "bun:test";
import { z } from "zod";
import { createRpcPeer, RpcFailure } from "./peer.js";
import { methodClient, serveMethods } from "./method-table.js";

const table = {
  "test.echo": { params: z.strictObject({ text: z.string() }), result: z.strictObject({ text: z.string() }), errorData: z.strictObject({ reason: z.string() }), timeoutMs: 20 },
  "test.note": { params: z.strictObject({ text: z.string() }) },
};
const EPOCH = crypto.randomUUID();

/** A calling peer wired to a peer serving `table`; `frames` records what the caller sent. */
function link(serving: Parameters<typeof createRpcPeer>[1]) {
  const frames: unknown[] = [];
  const ends: { receive(data: string): void }[] = [];
  const caller = createRpcPeer({ send: data => { frames.push(JSON.parse(data)); queueMicrotask(() => ends[1]!.receive(data)); }, close: () => {} }, {});
  const server = createRpcPeer({ send: data => queueMicrotask(() => ends[0]!.receive(data)), close: () => {} }, serving);
  ends.push(caller, server);
  return { caller, frames };
}

test("served methods check the frame's epoch and get their params without it", async () => {
  const seen: unknown[] = [];
  const { caller } = link(serveMethods(table, {
    "test.echo": async (input, context) => { seen.push([input, context]); if (input.text === "fail") throw new Error("boom"); return input; },
    "test.note": (input, context) => { seen.push([input, context]); },
  }, epoch => { if (epoch !== EPOCH) throw new RpcFailure(-32003, "Stale"); return "context"; }, error => new RpcFailure(-32000, `mapped: ${error instanceof Error ? error.message : ""}`)));
  expect(await caller.call("test.echo", { text: "hi", epoch: EPOCH }, z.unknown())).toEqual({ text: "hi" });
  caller.notify("test.note", { text: "later", epoch: EPOCH });
  await Bun.sleep(0);
  expect(seen).toEqual([[{ text: "hi" }, "context"], [{ text: "later" }, "context"]]);
  // No epoch or an extra field is invalid params; another epoch is refused before the handler runs.
  await expect(caller.call("test.echo", { text: "hi" }, z.unknown())).rejects.toMatchObject({ code: -32602 });
  await expect(caller.call("test.echo", { text: "hi", epoch: EPOCH, extra: 1 }, z.unknown())).rejects.toMatchObject({ code: -32602 });
  await expect(caller.call("test.echo", { text: "hi", epoch: crypto.randomUUID() }, z.unknown())).rejects.toMatchObject({ code: -32003 });
  // A handler's exception is sent as `failure` maps it.
  await expect(caller.call("test.echo", { text: "fail", epoch: EPOCH }, z.unknown())).rejects.toMatchObject({ code: -32000, message: "mapped: boom" });
  expect(seen).toHaveLength(3);
});

test("method calls carry the epoch and take their error data and default bound from the table", async () => {
  const { caller, frames } = link({
    "test.echo": { params: z.unknown(), result: z.unknown(), handle: async params => {
      const { text } = z.object({ text: z.string() }).parse(params);
      if (text === "reject") throw new RpcFailure(-32000, "Rejected", undefined, { reason: "no" });
      if (text === "hang") return new Promise(() => {});
      return { text };
    } },
  });
  const client = methodClient(caller, table);
  expect(await client.call("test.echo", EPOCH, { text: "hi" })).toEqual({ text: "hi" });
  expect(frames[0]).toMatchObject({ method: "test.echo", params: { text: "hi", epoch: EPOCH } });
  await expect(client.call("test.echo", EPOCH, { text: "reject" })).rejects.toMatchObject({ code: -32000, data: { reason: "no" } });
  await expect(client.call("test.echo", EPOCH, { text: "hang" })).rejects.toMatchObject({ outcome: "unknown", message: "Call timed out after 20ms; outcome unknown" });
  expect(client.notify("test.note", EPOCH, { text: "note" })).toBe(true);
  expect(frames.at(-1)).toEqual({ jsonrpc: "2.0", method: "test.note", params: { text: "note", epoch: EPOCH } });
});
