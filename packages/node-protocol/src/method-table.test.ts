import { test, expect } from "bun:test";
import { z } from "zod";
import { createRpcPeer, RpcFailure, INVALID_PARAMS, UNAUTHORIZED } from "./rpc.js";
import { APPLICATION_ERROR } from "./errors.js";
import { methodClient, serveMethods } from "./method-table.js";

const table = {
  "test.echo": { params: z.strictObject({ text: z.string() }), result: z.strictObject({ text: z.string() }), errorData: z.strictObject({ reason: z.string() }), timeoutMs: 20 },
  "test.note": { params: z.strictObject({ text: z.string() }) },
};

/** A calling peer wired to a peer serving `table`; `frames` records what the caller sent. */
function link(serving: Parameters<typeof createRpcPeer>[1]) {
  const frames: unknown[] = [];
  const ends: { receive(data: string): void }[] = [];
  const caller = createRpcPeer({ send: data => { frames.push(JSON.parse(data)); queueMicrotask(() => ends[1]!.receive(data)); }, close: () => {} }, {});
  const server = createRpcPeer({ send: data => queueMicrotask(() => ends[0]!.receive(data)), close: () => {} }, serving);
  ends.push(caller, server);
  return { caller, frames };
}

test("served methods are authorized before their handler runs and get their params as the table parses them", async () => {
  const seen: unknown[] = [];
  let negotiated = true;
  const { caller } = link(serveMethods(table, {
    "test.echo": async input => { seen.push(input); if (input.text === "fail") throw new Error("boom"); return input; },
    "test.note": input => { seen.push(input); },
  }, () => { if (!negotiated) throw new RpcFailure(UNAUTHORIZED, "Not negotiated"); }, error => new RpcFailure(APPLICATION_ERROR, `mapped: ${error instanceof Error ? error.message : ""}`)));
  expect(await caller.call("test.echo", { text: "hi" }, z.unknown())).toEqual({ text: "hi" });
  caller.notify("test.note", { text: "later" });
  await Bun.sleep(0);
  expect(seen).toEqual([{ text: "hi" }, { text: "later" }]);
  // An extra field (an epoch of an earlier protocol too) is invalid params.
  await expect(caller.call("test.echo", { text: "hi", epoch: crypto.randomUUID() }, z.unknown())).rejects.toMatchObject({ code: INVALID_PARAMS });
  // A handler's exception is sent as `failure` maps it.
  await expect(caller.call("test.echo", { text: "fail" }, z.unknown())).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "mapped: boom" });
  // An unauthorized frame is refused before its handler runs.
  negotiated = false;
  await expect(caller.call("test.echo", { text: "hi" }, z.unknown())).rejects.toMatchObject({ code: UNAUTHORIZED });
  expect(seen).toHaveLength(3);
});

test("method calls send their params as they are and take their error data and default bound from the table", async () => {
  const { caller, frames } = link({
    "test.echo": { params: z.unknown(), result: z.unknown(), handle: async params => {
      const { text } = z.object({ text: z.string() }).parse(params);
      if (text === "reject") throw new RpcFailure(APPLICATION_ERROR, "Rejected", undefined, { reason: "no" });
      if (text === "hang") return new Promise(() => {});
      return { text };
    } },
  });
  const client = methodClient(caller, table);
  expect(await client.call("test.echo", { text: "hi" })).toEqual({ text: "hi" });
  expect(frames[0]).toMatchObject({ method: "test.echo", params: { text: "hi" } });
  await expect(client.call("test.echo", { text: "reject" })).rejects.toMatchObject({ code: APPLICATION_ERROR, data: { reason: "no" } });
  await expect(client.call("test.echo", { text: "hang" })).rejects.toMatchObject({ outcome: "unknown", message: "Call timed out after 20ms; outcome unknown" });
  expect(client.notify("test.note", { text: "note" })).toBe(true);
  expect(frames.at(-1)).toEqual({ jsonrpc: "2.0", method: "test.note", params: { text: "note" } });
});
