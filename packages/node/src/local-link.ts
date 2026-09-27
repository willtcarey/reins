import type { Node } from "./node.js";
import { connectNode } from "./node-connection.js";
import { LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, ndjsonSocketHandler, systemTimers, type LinkOptions } from "./protocol/connection.js";

/** Reconnect delays: exponential from `initialMs`, capped at `maxMs`, with "equal jitter" (each delay is
 * uniformly random in [d/2, d]) so many nodes restarting together do not dial in lockstep. */
export interface Backoff { initialMs: number; maxMs: number }
export const RECONNECT_BACKOFF: Backoff = { initialMs: 100, maxMs: 5_000 };

export interface LocalNodeClientOptions extends LinkOptions {
  /** The server's Unix socket. */
  path: string;
  instanceId?: string;
  backoff?: Backoff;
  /** Injectable for tests; `Math.random` by default. */
  random?: () => number;
  /** Called when a connection negotiates, and when a negotiated connection closes (for logging). */
  onStatus?: (status: "connected" | "disconnected") => void;
}

export interface LocalNodeClient {
  /** Closes the current connection and never dials again. Call before stopping the node. */
  stop(): void;
}

/**
 * Node side of the local link: dials the server's Unix socket, runs the node protocol (`connectNode`)
 * over NDJSON frames and redials whenever a dial fails or the connection closes, after a backoff that
 * resets once a connection negotiates. Every connection is a new attach: the node replays each session's
 * pending outbox and drops its credential cache (see node-contract.md *Transport*).
 */
export function connectLocalNode(node: Node, options: LocalNodeClientOptions): LocalNodeClient {
  const { path, instanceId = "internal", backoff = RECONNECT_BACKOFF, random = Math.random, onStatus, ...overrides } = options;
  const link: LinkOptions = { ...LOCAL_LINK, ...overrides };
  const timers = link.timers ?? systemTimers;
  let stopped = false;
  let attempt = 0;
  let timer: unknown;
  let current: { close(): void } | undefined;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    const ceiling = Math.min(backoff.maxMs, backoff.initialMs * 2 ** attempt);
    attempt++;
    timer = timers.setTimeout(() => { timer = undefined; void dial(); }, ceiling / 2 + random() * ceiling / 2);
  };
  const dial = async () => {
    if (stopped) return;
    try {
      await Bun.connect({
        unix: path,
        // Wired synchronously on open, before any frame can arrive.
        socket: ndjsonSocketHandler(link.maxFrameBytes ?? LOCAL_MAX_FRAME_BYTES, wire => {
          if (stopped) { wire.close(); return; }
          const connection = connectNode(node, wire, instanceId, link);
          current = connection;
          let negotiated = false;
          wire.onmessage = connection.receive;
          wire.onclose = () => {
            connection.close();
            if (current === connection) current = undefined;
            if (negotiated && !stopped) onStatus?.("disconnected");
            schedule();
          };
          connection.ready.then(() => {
            attempt = 0;
            if (wire.closed) return;
            negotiated = true;
            onStatus?.("connected");
          }, () => undefined);
        }),
      });
    } catch {
      // Nothing listening (or the socket is not ours to open): try again later.
      schedule();
    }
  };
  void dial();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      current?.close();
      current = undefined;
    },
  };
}
