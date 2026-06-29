import { describe, expect, test } from "bun:test";
import { asyncIterableToText } from "../async-iterable.js";

async function* mixedChunks() {
  yield "hello ";
  yield new TextEncoder().encode("wor").buffer;
  yield new TextEncoder().encode("ld");
}

async function* splitMultibyteChunks(bytes: Uint8Array) {
  yield bytes.subarray(0, 2);
  yield bytes.subarray(2, 4);
  yield bytes.subarray(4);
}

describe("asyncIterableToText", () => {
  test("reads string, ArrayBuffer, and view chunks", async () => {
    expect(await asyncIterableToText(mixedChunks())).toBe("hello world");
  });

  test("decodes multibyte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("a🙂b");

    expect(await asyncIterableToText(splitMultibyteChunks(bytes))).toBe("a🙂b");
  });
});