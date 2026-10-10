import type { Node } from "./node.js";
import { connectNode } from "./node-connection.js";
import { NODE_REFUSED, RpcFailure, systemTimers, type LinkOptions, type LinkSocket, type NodeIdentity } from "@reins/node-protocol";

/** Reconnect delays: exponential from `initialMs`, capped at `maxMs`, with "equal jitter" (each delay is
 * uniformly random in [d/2, d]) so many nodes restarting together do not dial in lockstep. */
export interface Backoff { initialMs: number; maxMs: number }
const RECONNECT_BACKOFF: Backoff = { initialMs: 100, maxMs: 5_000 };

/** How a node's link client redials and what it reports; the same for every transport. */
export interface RedialOptions {
  backoff?: Backoff;
  /** Injectable for tests; `Math.random` by default. */
  random?: () => number;
  /** Called when a connection negotiates, and when a negotiated connection closes (for logging). */
  onStatus?: (status: "connected" | "disconnected") => void;
  /** Called once when the server refuses this node (`NODE_REFUSED`), with its reason; the client has then
   * stopped. Without it the refusal is logged. */
  onRefused?: (message: string) => void;
}

export interface NodeLinkClient {
  /** Closes the current connection and never dials again. Call before stopping the node. */
  stop(): void;
}

/** Opens one connection to the server: calls `opened` with its socket as soon as it is open (before any
 * frame can arrive), and rejects when no connection opened. */
export type Dial = (opened: (wire: LinkSocket) => void) => Promise<unknown>;

/**
 * A node's link to its server over any transport (`dial`): runs the node protocol (`connectNode`) on each
 * connection and redials whenever a dial fails or the connection closes, after a backoff that resets once
 * a connection negotiates. A hello the server refuses as `NODE_REFUSED` (an unknown or revoked node, or
 * failed authentication) stops it instead: it never dials again and reports the refusal (`onRefused`).
 * Every connection is a new attach: the node announces its live sessions and drops its credential cache
 * (see node-transport.md *Details: reconnecting*). `connectLocalNode` and `connectRemoteNode` are this
 * over the Unix socket and the WebSocket.
 */
export function redialNode(node: Node, dial: Dial, nodeId: string, link: LinkOptions & { identity?: NodeIdentity }, options: RedialOptions = {}): NodeLinkClient {
  const { backoff = RECONNECT_BACKOFF, random = Math.random, onStatus, onRefused } = options;
  const timers = link.timers ?? systemTimers;
  let stopped = false;
  let attempt = 0;
  let timer: unknown;
  let current: { close(): void } | undefined;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    const ceiling = Math.min(backoff.maxMs, backoff.initialMs * 2 ** attempt);
    attempt++;
    timer = timers.setTimeout(() => { timer = undefined; void connect(); }, ceiling / 2 + random() * ceiling / 2);
  };
  const opened = (wire: LinkSocket) => {
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
  };
  const connect = async () => {
    if (stopped) return;
    // Nothing listening, unreachable, or the endpoint refused the connection: try again later.
    try { await dial(opened); } catch { schedule(); }
  };
  function stop() {
    stopped = true;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    current?.close();
    current = undefined;
  }
  void connect();
  return { stop };
}
