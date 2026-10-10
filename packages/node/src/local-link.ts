import type { Node } from "./node.js";
import { connectNode } from "./node-connection.js";
import { LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, NODE_REFUSED, ndjsonSocketHandler, RpcFailure, systemTimers, type LinkOptions } from "@reins/node-protocol";

/** Reconnect delays: exponential from `initialMs`, capped at `maxMs`, with "equal jitter" (each delay is
 * uniformly random in [d/2, d]) so many nodes restarting together do not dial in lockstep. */
export interface Backoff { initialMs: number; maxMs: number }
const RECONNECT_BACKOFF: Backoff = { initialMs: 100, maxMs: 5_000 };

/** The node ID a local node announces in `node.hello` unless configured otherwise (`REINS_NODE_ID`): the
 * ID of the node row the server's migrations seed for this machine. The server has no notion of a local
 * node; it serves any connection whose ID names one of its nodes. */
export const DEFAULT_LOCAL_NODE_ID = "internal";

interface LocalNodeClientOptions extends LinkOptions {
  /** The server's Unix socket. */
  path: string;
  /** Announced in `node.hello`; `DEFAULT_LOCAL_NODE_ID` by default. */
  nodeId?: string;
  backoff?: Backoff;
  /** Injectable for tests; `Math.random` by default. */
  random?: () => number;
  /** Called when a connection negotiates, and when a negotiated connection closes (for logging). */
  onStatus?: (status: "connected" | "disconnected") => void;
  /** Called once when the server refuses this node (`NODE_REFUSED`), with its reason; the client has then
   * stopped. Without it the refusal is logged. */
  onRefused?: (message: string) => void;
}

interface LocalNodeClient {
  /** Closes the current connection and never dials again. Call before stopping the node. */
  stop(): void;
}

/**
 * Node side of the local link: dials the server's Unix socket, runs the node protocol (`connectNode`)
 * over NDJSON frames and redials whenever a dial fails or the connection closes, after a backoff that
 * resets once a connection negotiates. A hello the server refuses as `NODE_REFUSED` (an unknown or revoked
 * node) stops it instead: it never dials again and reports the refusal (`onRefused`). Every connection is
 * a new attach: the node announces its live sessions and drops its credential cache (see
 * node-transport.md *4. The connection*).
 */
export function connectLocalNode(node: Node, options: LocalNodeClientOptions): LocalNodeClient {
  const { path, nodeId = DEFAULT_LOCAL_NODE_ID, backoff = RECONNECT_BACKOFF, random = Math.random, onStatus, onRefused, ...overrides } = options;
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
          const connection = connectNode(node, wire, nodeId, link);
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
          }, (error: unknown) => {
            if (stopped) return;
            // The server will not serve this node: redialing cannot help.
            if (error instanceof RpcFailure && error.code === NODE_REFUSED) {
              stop();
              if (onRefused) onRefused(error.message);
              else console.warn(`[node] refused by the server: ${error.message}; not reconnecting`);
              return;
            }
            // Any other failed hello (no common protocol version, a timeout) is retried like a failed dial;
            // say why, since nothing else will.
            console.warn(`[node] negotiation failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }),
      });
    } catch {
      // Nothing listening (or the socket is not ours to open): try again later.
      schedule();
    }
  };
  function stop() {
    stopped = true;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    current?.close();
    current = undefined;
  }
  void dial();
  return { stop };
}
