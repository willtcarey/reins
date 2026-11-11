import { expect, test } from "bun:test";
import { outputFrames } from "@reins/node-protocol";
import { splitOutput } from "../../nodes/process-output.js";

/** A process's output stream as the server's registry gives it: `frames` as one body. */
const body = (...frames: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(frame); controller.close(); } });

test("stderr is handed on and the output's end known while nobody reads stdout, which is kept for its reader", async () => {
  const stderr: string[] = [];
  const { stdout, done } = splitOutput(body(...outputFrames("stdout", Buffer.from("one\n")), ...outputFrames("stderr", Buffer.from("warn\n")), ...outputFrames("stdout", Buffer.from("two\n"))),
    bytes => stderr.push(Buffer.from(bytes).toString()));

  expect(await done).toBeUndefined();
  expect(stderr).toEqual(["warn\n"]);
  expect(await new Response(stdout).text()).toBe("one\ntwo\n");
});

test("stdout nobody reads fails the output once it holds more than its buffer", async () => {
  const { stdout, done } = splitOutput(body(...outputFrames("stdout", Buffer.alloc(10)), ...outputFrames("stdout", Buffer.alloc(10))), () => {}, { maxBufferedBytes: 15 });

  expect(await done).toMatchObject({ message: "Its stdout exceeded its 15-byte buffer: nobody is reading it" });
  await expect(new Response(stdout).text()).rejects.toThrow("Its stdout exceeded its 15-byte buffer");
});
