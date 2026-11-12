/**
 * A process run to its end on the server (`process.start`, node-contract.md *Processes*; `NodeDirClient.spawner`):
 * its output stream's frames split into stdout, a stream of its own, and stderr, handed on as it comes. The body is read as it arrives, so
 * stderr is seen and the end is known whether or not anyone reads stdout; stdout not read is held up to
 * `maxBufferedBytes`, then the output fails.
 */

import { outputParser } from "@reins/node-protocol";
import { MAX_STREAM_BUFFER_BYTES } from "./node-streams.js";

/** How much of a process's stderr the server keeps to say why it failed. */
export const STDERR_TAIL_CHARS = 64 * 1024;

export interface SplitOutput {
  stdout: ReadableStream<Uint8Array>;
  /** Settles once the body has been read to its end, with what failed it, if anything: the frames, or stdout
   * past its buffer. A cancelled stdout or a dropped link ends it too (the stream's `ended` says why). */
  done: Promise<Error | undefined>;
}

/** `stop` stops the process: a stream's end leaves it running on its node, so cancelling stdout or failing the
 * output calls it. */
export function splitOutput(body: ReadableStream<Uint8Array>, onStderr: (bytes: Uint8Array) => void, { maxBufferedBytes = MAX_STREAM_BUFFER_BYTES, stop = () => {} }: { maxBufferedBytes?: number; stop?: () => void } = {}): SplitOutput {
  const reader = body.getReader();
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(given) { controller = given; },
    cancel(reason) { cancelled = true; stop(); return reader.cancel(reason); },
  }, { highWaterMark: maxBufferedBytes, size: chunk => chunk?.byteLength ?? 0 });
  const parser = outputParser((channel, bytes) => {
    if (channel === "stderr") { onStderr(bytes); return; }
    if (cancelled) return;
    controller.enqueue(bytes);
    if ((controller.desiredSize ?? 0) < 0) throw new Error(`Its stdout exceeded its ${maxBufferedBytes}-byte buffer: nobody is reading it`);
  });
  const done = (async (): Promise<Error | undefined> => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        parser.push(value);
      }
      if (cancelled) return undefined;
      parser.end();
      controller.close();
      return undefined;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!cancelled) { controller.error(failure); stop(); }
      await reader.cancel(failure).catch(() => undefined);
      return failure;
    }
  })();
  return { stdout, done };
}

/** A stderr tail that decodes as it grows. */
export function stderrTail() {
  const decoder = new TextDecoder();
  let tail = "";
  return {
    /** Adds `bytes`; returns their text. */
    add(bytes: Uint8Array): string {
      const text = decoder.decode(bytes, { stream: true });
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
      return text;
    },
    get text() { return tail; },
  };
}
