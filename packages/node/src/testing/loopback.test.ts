import { test, expect } from "bun:test";
import { createLoopbackPair } from "./loopback.js";
import { createRpcPeer } from "../protocol/peer.js";
import { z } from "zod";

/** An ad-hoc result schema: the peer is method-agnostic. */
const statusResult = z.strictObject({ provisioned: z.boolean() });

test("delivers string frames to the other end asynchronously and in order", async () => {
  const [a, b] = createLoopbackPair();
  const received: string[] = [];
  b.onmessage = data => received.push(data);
  a.onmessage = () => { throw new Error("frames must not echo to the sender"); };
  a.send("one");
  a.send("two");
  expect(received).toEqual([]);
  await Bun.sleep(0);
  expect(received).toEqual(["one", "two"]);
  expect(() => Reflect.apply(a.send, a, [new Uint8Array(1)])).toThrow(TypeError);
});

test("closing either end closes both, notifies both asynchronously and drops queued frames", async () => {
  const [a, b] = createLoopbackPair();
  const events: string[] = [];
  b.onmessage = data => events.push(`b:${data}`);
  a.onclose = () => events.push("a:close");
  b.onclose = () => events.push("b:close");
  a.send("lost");
  b.close();
  expect(a.closed).toBe(true);
  expect(events).toEqual([]);
  expect(() => a.send("late")).toThrow("closed");
  await Bun.sleep(0);
  expect(events).toEqual(["a:close", "b:close"]);
});

test("peers over a loopback correlate calls and fail pending calls as unknown when the far end closes", async () => {
  const [a, b] = createLoopbackPair();
  let release!: () => void;
  const client = createRpcPeer(a, {});
  const server = createRpcPeer(b, {
    "test.status": { params: z.object({ sessionId: z.string() }), result: statusResult,
      handle: async value => value && typeof value === "object" && "sessionId" in value && value.sessionId === "hang"
        ? new Promise(resolve => { release = () => resolve({ provisioned: true }); }) : { provisioned: true } },
  });
  a.onmessage = client.receive; a.onclose = client.close;
  b.onmessage = server.receive; b.onclose = server.close;
  expect(await client.call("test.status", { sessionId: "s" }, statusResult)).toEqual({ provisioned: true });
  const pending = client.call("test.status", { sessionId: "hang" }, statusResult);
  await Bun.sleep(0);
  b.close();
  release();
  await expect(pending).rejects.toMatchObject({ outcome: "unknown" });
});
