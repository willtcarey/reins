/**
 * Output the node keeps for a server that may lose its stream and come back for it (node-contract.md *Shell
 * commands*, *Processes*): the items of a command's or a process's output stream (`pi.exec`'s records,
 * `process.start`'s frames) with their byte offsets, a bounded tail of them, and a grace period while no
 * stream is open. `pi-exec.ts` and `processes.ts` keep their output in one each; what to do when the grace
 * period ends, and where to start a stream from an offset no longer kept, is theirs.
 *
 * One stream at a time: opening a stream stops the one open before it. Items the open stream has not sent are
 * never dropped, so a stream that reads slowly loses nothing; behind it, and while no stream is open, only the
 * last `tailBytes` are kept.
 */
import type { ProcessExit } from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";

export interface OutputBufferOptions {
  tailBytes: number;
  graceMs: number;
  /** No stream opened within the grace period after the last one stopped, or after it was made. */
  onExpired(): void;
  /** The last item is the end's (pi's exit record): keep it to be read again once a stream has sent it.
   * Otherwise a stream that sent everything leaves nothing kept but the result. */
  keepFinalItem?: boolean;
}

interface Item { offset: number; data: string | Uint8Array; bytes: number }

/** `Result` is what a stream returns at its end: a process's exit, or nothing. */
export class OutputBuffer<Result extends ProcessExit | void = void> {
  private readonly items: Item[] = [];
  /** How many items were dropped before `items[0]`: an item's index counts from the first ever added. */
  private dropped = 0;
  private bytes = 0;
  private result: { value: Result } | undefined;
  private changed = Promise.withResolvers<void>();
  private consumer: { controller: AbortController; next: number } | undefined;
  private grace: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: OutputBufferOptions) {
    this.startGrace();
  }

  /** Where the next item starts: the bytes of every item so far. */
  get end(): number { return this.bytes; }
  /** Where the oldest item kept starts; `end` when none is. */
  get start(): number { return this.items[0]?.offset ?? this.bytes; }
  /** Where the last item kept starts; `end` when none is. */
  get lastStart(): number { return this.items.at(-1)?.offset ?? this.bytes; }
  get finished(): boolean { return this.result !== undefined; }
  /** A stream is open. */
  get streaming(): boolean { return this.consumer !== undefined; }

  /** Whether a stream may start at `offset`: where a kept item starts, or the end. */
  isItemStart(offset: number): boolean {
    return offset === this.bytes || this.items.some(item => item.offset === offset);
  }

  add(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (bytes === 0) return;
    this.items.push({ offset: this.bytes, data, bytes });
    this.bytes += bytes;
    this.trim();
    this.wake();
  }

  /** No more items: a stream ends, after the items, with `result`. */
  finish(result: Result): void {
    this.result = { value: result };
    this.wake();
  }

  /** The items from the one starting at `offset` (`isItemStart`), then the result, stopping the stream open
   * before. A stream stopped by another one fails, so its end says why. */
  stream(offset: number): OpenStreamSource {
    return signal => this.serve(offset, signal);
  }

  /** Its owner forgets it: the grace period stops, and never starts again. */
  close(): void {
    this.closed = true;
    clearTimeout(this.grace);
  }

  private async *serve(offset: number, signal: AbortSignal): AsyncGenerator<string | Uint8Array, Result | undefined> {
    this.consumer?.controller.abort();
    const at = this.items.findIndex(item => item.offset === offset);
    const consumer = { controller: new AbortController(), next: this.dropped + (offset === this.bytes || at < 0 ? this.items.length : at) };
    this.consumer = consumer;
    clearTimeout(this.grace);
    const stopped = new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      consumer.controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let delivered = false;
    try {
      for (;;) {
        if (signal.aborted) return undefined;
        if (consumer.controller.signal.aborted) throw new Error("Another stream attached to this output");
        const item = this.items[consumer.next - this.dropped];
        if (item) {
          consumer.next++;
          yield item.data;
          this.trim();
          continue;
        }
        if (this.result) { delivered = true; return this.result.value; }
        const changed = this.changed.promise;
        await Promise.race([changed, stopped]);
      }
    } finally {
      if (this.consumer === consumer) {
        this.consumer = undefined;
        if (delivered) this.release();
        if (!this.closed) this.startGrace();
      }
    }
  }

  /** Drops what is behind the open stream (all of it, with none open) past the tail; the latest item is kept
   * whatever its size. */
  private trim(): void {
    const sentUpTo = this.consumer?.next ?? Infinity;
    while (this.items.length > 1 && this.dropped < sentUpTo && this.bytes - this.items[0]!.offset > this.options.tailBytes) {
      this.items.shift();
      this.dropped++;
    }
  }

  /** A stream sent everything: what is kept would only be sent again. */
  private release(): void {
    const keep = this.options.keepFinalItem ? 1 : 0;
    const drop = Math.max(0, this.items.length - keep);
    this.items.splice(0, drop);
    this.dropped += drop;
  }

  private wake(): void {
    this.changed.resolve();
    this.changed = Promise.withResolvers();
  }

  private startGrace(): void {
    clearTimeout(this.grace);
    this.grace = setTimeout(() => {
      if (!this.consumer && !this.closed) this.options.onExpired();
    }, this.options.graceMs);
    this.grace.unref();
  }
}
