import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSocket, ndjsonSocketHandler, type NdjsonSocket } from "./local-socket.js";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A byte stream that accepts at most `capacity` bytes per write (Infinity: everything). */
function stream(capacity = Infinity) {
  const written: Uint8Array[] = [];
  const state = { capacity, ended: false };
  return {
    state,
    text: () => Buffer.concat(written).toString("utf8"),
    write(data: Uint8Array) {
      const n = Math.min(data.byteLength, state.capacity);
      state.capacity -= n;
      written.push(data.slice(0, n));
      return n;
    },
    end() { state.ended = true; },
  };
}
function socket(maxFrameBytes = 1024, capacity = Infinity) {
  const out = stream(capacity);
  const wire = createNdjsonSocket(out, { maxFrameBytes });
  const frames: string[] = [];
  let closes = 0;
  wire.onmessage = data => frames.push(data);
  wire.onclose = () => closes++;
  return { out, wire, frames, closes: () => closes };
}

test("reassembles frames split across chunks and splits several frames in one chunk", () => {
  const { wire, frames } = socket();
  wire.receive(bytes('{"a":'));
  wire.receive(bytes('1}\n{"b":2}\n{"c"'));
  expect(frames).toEqual(['{"a":1}', '{"b":2}']);
  wire.receive(bytes(":3}\n"));
  expect(frames).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("reassembles a multi-byte UTF-8 character split between chunks", () => {
  const { wire, frames } = socket();
  const encoded = bytes('"é😀"\n');
  // Split inside the 2-byte é and inside the 4-byte emoji.
  wire.receive(encoded.subarray(0, 2));
  wire.receive(encoded.subarray(2, 5));
  wire.receive(encoded.subarray(5));
  expect(frames).toEqual(['"é😀"']);
});

test("a kept partial frame survives the stream reusing its chunk buffer", () => {
  const { wire, frames } = socket();
  const chunk = bytes('"abc');
  wire.receive(chunk);
  chunk.fill(0x78);
  wire.receive(bytes('"\n'));
  expect(frames).toEqual(['"abc"']);
});

test("invalid UTF-8 closes the socket", async () => {
  const { wire, frames, closes } = socket();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  wire.receive(new Uint8Array([0x22, 0xff, 0x22, 0x0a]));
  warn.mockRestore();
  expect(frames).toEqual([]);
  expect(wire.closed).toBe(true);
  await Bun.sleep(0);
  expect(closes()).toBe(1);
});

test("a frame over the cap closes as soon as the partial frame crosses it, without buffering the rest", async () => {
  const { out, wire, frames, closes } = socket(8);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  wire.receive(bytes('"12345678"\n'.slice(0, 5)));
  expect(wire.closed).toBe(false);
  wire.receive(bytes("6789"));
  warn.mockRestore();
  expect(wire.closed).toBe(true);
  expect(out.state.ended).toBe(true);
  wire.receive(bytes('"\n"x"\n'));
  expect(frames).toEqual([]);
  await Bun.sleep(0);
  expect(closes()).toBe(1);
  // Exactly the cap is accepted.
  const exact = socket(8);
  exact.wire.receive(bytes('"123456"\n'));
  expect(exact.frames).toEqual(['"123456"']);
});

test("send terminates frames with a newline and rejects a frame containing one", () => {
  const { out, wire } = socket();
  wire.send(JSON.stringify({ text: "line\nbreak" }));
  expect(out.text()).toBe('{"text":"line\\nbreak"}\n');
  expect(() => wire.send("{}\n{}")).toThrow("must not contain a newline");
  expect(() => Reflect.apply(wire.send, wire, [new Uint8Array(1)])).toThrow(TypeError);
  expect(() => socket(4).wire.send('"12345"')).toThrow(RangeError);
  expect(out.text()).toBe('{"text":"line\\nbreak"}\n');
});

test("bytes the stream does not accept are queued in order and written on drain; drained() resolves once the queue is empty", async () => {
  const { out, wire } = socket(1024, 3);
  let drained = false;
  await wire.drained();
  wire.send('"abcdef"');
  wire.send('"g"');
  void wire.drained().then(() => { drained = true; });
  expect(out.text()).toBe('"ab');
  expect(wire.queuedBytes).toBe(9 - 3 + 4);
  out.state.capacity = 7;
  wire.drain();
  expect(out.text()).toBe('"abcdef"\n"');
  await Bun.sleep(0);
  expect(drained).toBe(false);
  out.state.capacity = Infinity;
  wire.drain();
  expect(out.text()).toBe('"abcdef"\n"g"\n');
  expect(wire.queuedBytes).toBe(0);
  await Bun.sleep(0);
  expect(drained).toBe(true);
  // A write reporting the stream closed closes the socket.
  const closed = socket(1024, 0);
  closed.out.write = () => -1;
  closed.wire.send("{}");
  expect(closed.wire.closed).toBe(true);
});

test("close ends the stream once, drops queued bytes, notifies asynchronously, and refuses later sends", async () => {
  const { out, wire, closes, frames } = socket(1024, 0);
  wire.send('"queued"');
  // A sender waiting for the queue to drain is released by the close.
  const waiting = wire.drained();
  wire.close();
  wire.close();
  wire.ended();
  expect(out.state.ended).toBe(true);
  expect(wire.queuedBytes).toBe(0);
  expect(closes()).toBe(0);
  await waiting;
  await Bun.sleep(0);
  expect(closes()).toBe(1);
  expect(() => wire.send("{}")).toThrow("closed");
  wire.receive(bytes("{}\n"));
  expect(frames).toEqual([]);
});

test("over a real Unix socket: frames cross both ways, a large frame crosses under backpressure, and a close reaches the other end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-ndjson-"));
  const path = join(dir, "s.sock");
  let serverSide: NdjsonSocket | undefined;
  const serverFrames: string[] = [];
  let serverDone = false;
  const serverClosed = () => serverDone;
  const listener = Bun.listen({ unix: path, socket: ndjsonSocketHandler(64 * 1024 * 1024, wire => {
    serverSide = wire;
    wire.onmessage = data => { serverFrames.push(data); wire.send(data); };
    wire.onclose = () => { serverDone = true; };
  }) });
  try {
    const clientFrames: string[] = [];
    let clientSide: NdjsonSocket | undefined;
    const closed = { client: false, server: false };
    await Bun.connect({ unix: path, socket: ndjsonSocketHandler(64 * 1024 * 1024, wire => {
      clientSide = wire;
      wire.onmessage = data => clientFrames.push(data);
      wire.onclose = () => { closed.client = true; };
    }) });
    const big = JSON.stringify("é".repeat(8 * 1024 * 1024));
    clientSide!.send('"hi"');
    clientSide!.send(big);
    clientSide!.send('"after"');
    for (let i = 0; i < 400 && clientFrames.length < 3; i++) await Bun.sleep(5);
    expect(serverFrames.map(frame => frame.length)).toEqual([4, big.length, 7]);
    expect(clientFrames[1] === big && clientFrames[2] === '"after"').toBe(true);
    serverSide!.close();
    for (let i = 0; i < 100 && !closed.client; i++) await Bun.sleep(5);
    expect([closed.client, serverClosed()]).toEqual([true, true]);
  } finally { listener.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
