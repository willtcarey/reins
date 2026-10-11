import { expect, spyOn, test } from "bun:test";
import { createWebSocketLink, nodeLinkUrl, type MessageStream } from "./websocket-link.js";

/** A WebSocket as Bun's server socket behaves: `send` buffers once `backpressure` bytes are pending
 * (answering -1), and drops a message (0) sent while more than `limit` bytes are pending. */
function fakeStream({ backpressure = Infinity, limit = Infinity } = {}) {
  const written: string[] = [];
  let pending = 0;
  const closes: Array<{ code?: number; reason?: string }> = [];
  const stream: MessageStream = {
    send(text) {
      if (pending > limit) return 0;
      written.push(text);
      if (pending + text.length <= backpressure) return text.length;
      pending += text.length;
      return -1;
    },
    bufferedAmount: () => pending,
    close: (code, reason) => { closes.push({ code, reason }); },
  };
  return { stream, written, closes, flushSome(bytes: number) { pending = Math.max(0, pending - bytes); } };
}
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => { done = true; });
  await Bun.sleep(0);
  return done;
};

test("a backpressured WebSocket holds later frames until it has written everything out, so it never drops one", async () => {
  const fake = fakeStream({ backpressure: 4, limit: 8 });
  const link = createWebSocketLink(fake.stream, { maxFrameBytes: 1024 });
  link.send("aaaaaa");
  link.send("bb");
  link.send("cc");
  // The first frame went to the WebSocket and backpressured it: the others wait in order.
  expect(fake.written).toEqual(["aaaaaa"]);
  const drained = link.drained();
  expect(await settled(drained)).toBe(false);
  // A drain that leaves bytes pending sends nothing yet: sending now could exceed the WebSocket's limit.
  fake.flushSome(3);
  link.drain();
  expect(fake.written).toEqual(["aaaaaa"]);
  fake.flushSome(3);
  link.drain();
  expect(fake.written).toEqual(["aaaaaa", "bb", "cc"]);
  expect(await settled(drained)).toBe(true);
  expect(fake.closes).toEqual([]);
});

test("a frame the WebSocket drops closes the link", async () => {
  const fake = fakeStream({ limit: -1 });
  const link = createWebSocketLink(fake.stream, { maxFrameBytes: 1024 });
  let closed = 0;
  link.onclose = () => closed++;
  link.send("lost");
  expect(link.closed).toBe(true);
  expect(fake.closes).toHaveLength(1);
  await Bun.sleep(0);
  expect(closed).toBe(1);
  expect(() => link.send("more")).toThrow();
});

test("an inbound message over the frame cap, or a binary one, closes the link without delivering it", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const message of ["é".repeat(513), new Uint8Array([1, 2, 3])]) {
      const fake = fakeStream();
      const link = createWebSocketLink(fake.stream, { maxFrameBytes: 1024 });
      const received: string[] = [];
      link.onmessage = data => received.push(data);
      link.receive("é".repeat(512));
      link.receive(message);
      link.receive("after");
      expect(received).toEqual(["é".repeat(512)]);
      expect(link.closed).toBe(true);
      expect(fake.closes).toHaveLength(1);
    }
  } finally { warn.mockRestore(); }
});

test("the node dials /nodes/link on its server, over wss for an https server", () => {
  expect(nodeLinkUrl("http://reins.local:3100")).toBe("ws://reins.local:3100/nodes/link");
  expect(nodeLinkUrl("https://reins.example.ts.net/")).toBe("wss://reins.example.ts.net/nodes/link");
  expect(nodeLinkUrl("https://proxy.example.test/reins")).toBe("wss://proxy.example.test/reins/nodes/link");
  expect(() => nodeLinkUrl("ftp://reins.local")).toThrow();
});
