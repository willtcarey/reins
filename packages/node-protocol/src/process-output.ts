/** A process's output on its one stream (`process.start`, node-contract.md *Processes*): stdout and stderr as
 * frames in the order the node read them, each a channel byte (1 stdout, 2 stderr), a big-endian 32-bit length
 * and the bytes. The stream's chunks split frames anywhere, so the reader joins them. */

export type OutputChannel = "stdout" | "stderr";
const CHANNELS: Record<OutputChannel, number> = { stdout: 1, stderr: 2 };
/** A frame's channel byte and length: offsets into a process's output count these too. */
export const OUTPUT_FRAME_HEADER_BYTES = 5;
const HEADER_BYTES = OUTPUT_FRAME_HEADER_BYTES;
/** Bounds what a reader holds for one frame; a writer splits longer output. */
export const MAX_OUTPUT_FRAME_BYTES = 1024 * 1024;

/** `bytes` of `channel` as frames. */
export function outputFrames(channel: OutputChannel, bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let start = 0; start < bytes.byteLength; start += MAX_OUTPUT_FRAME_BYTES) {
    const data = bytes.subarray(start, start + MAX_OUTPUT_FRAME_BYTES);
    const frame = new Uint8Array(HEADER_BYTES + data.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint8(0, CHANNELS[channel]);
    view.setUint32(1, data.byteLength);
    frame.set(data, HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

/** Reads frames from the stream's chunks, in order: `push` each chunk, then `end`. Each throws for bytes that
 * are not frames. */
export function outputParser(onFrame: (channel: OutputChannel, bytes: Uint8Array) => void) {
  let pending: Uint8Array = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): void {
      let buffer = pending.byteLength === 0 ? chunk : concat(pending, chunk);
      while (buffer.byteLength >= HEADER_BYTES) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const code = view.getUint8(0);
        const channel = code === CHANNELS.stdout ? "stdout" : code === CHANNELS.stderr ? "stderr" : null;
        if (!channel) throw new Error(`Not process output: unknown channel ${code}`);
        const length = view.getUint32(1);
        if (length > MAX_OUTPUT_FRAME_BYTES) throw new Error(`Not process output: a frame of ${length} bytes`);
        if (buffer.byteLength < HEADER_BYTES + length) break;
        onFrame(channel, buffer.subarray(HEADER_BYTES, HEADER_BYTES + length));
        buffer = buffer.subarray(HEADER_BYTES + length);
      }
      // Kept as a copy: the chunk's buffer may be reused.
      pending = buffer.slice();
    },
    end(): void {
      if (pending.byteLength > 0) throw new Error("Process output ended inside a frame");
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a);
  joined.set(b, a.byteLength);
  return joined;
}
