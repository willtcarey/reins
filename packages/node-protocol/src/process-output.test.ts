import { expect, test } from "bun:test";
import { MAX_OUTPUT_FRAME_BYTES, outputFrames, outputParser, type OutputChannel } from "./process-output.js";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

/** What a parser gives for `bytes` fed in pieces of `size`. */
function parse(bytes: Uint8Array, size: number) {
  const frames: [OutputChannel, string][] = [];
  const parser = outputParser((channel, data) => frames.push([channel, text(data)]));
  for (let start = 0; start < bytes.byteLength; start += size) parser.push(bytes.subarray(start, start + size));
  parser.end();
  return frames;
}

test("a process's stdout and stderr cross as one stream of tagged frames, read back in order however the stream is split", () => {
  const bytes = Buffer.concat([...outputFrames("stdout", Buffer.from("{\"id\":1}\n")), ...outputFrames("stderr", Buffer.from("warn: é\n")), ...outputFrames("stdout", Buffer.from("done"))]);
  const expected: [OutputChannel, string][] = [["stdout", "{\"id\":1}\n"], ["stderr", "warn: é\n"], ["stdout", "done"]];

  for (const size of [1, 2, 5, 7, bytes.byteLength]) expect(parse(bytes, size)).toEqual(expected);
});

test("output larger than a frame may hold crosses as several frames", () => {
  const large = Buffer.alloc(MAX_OUTPUT_FRAME_BYTES + 3, 97);

  const frames = outputFrames("stdout", large);

  expect(frames.map(frame => frame.byteLength - 5)).toEqual([MAX_OUTPUT_FRAME_BYTES, 3]);
  expect(parse(Buffer.concat(frames), 65_536).map(([, data]) => data).join("")).toBe(large.toString());
});

test("a stream that is not frames fails: an unknown channel, a frame longer than allowed, or one cut off at the end", () => {
  const unknown = Buffer.from([9, 0, 0, 0, 1, 97]);
  const tooLong = Buffer.alloc(5);
  tooLong[0] = 1;
  tooLong.writeUInt32BE(MAX_OUTPUT_FRAME_BYTES + 1, 1);
  const cut = outputFrames("stderr", Buffer.from("abc"))[0]!.subarray(0, 6);

  expect(() => parse(unknown, 6)).toThrow("Not process output: unknown channel 9");
  expect(() => parse(tooLong, 5)).toThrow(`Not process output: a frame of ${MAX_OUTPUT_FRAME_BYTES + 1} bytes`);
  expect(() => parse(cut, 6)).toThrow("Process output ended inside a frame");
});
