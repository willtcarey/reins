import type { Node } from "./node.js";
import { connectNode } from "./node-connection.js";
import { NODE_REFUSED, RpcFailure, systemTimers, UpdateRequired, type BuildUpdate, type LinkOptions, type LinkSocket, type NodeIdentity } from "@reins/node-protocol";

/** Reconnect delays: exponential from `initialMs`, capped at `maxMs`, with "equal jitter" (each delay is
 * uniformly random in [d/2, d]) so many nodes restarting together do not dial in lockstep. */
export interface Backoff { initialMs: number; maxMs: number }
const RECONNECT_BACKOFF: Backoff = { initialMs: 100, maxMs: 5_000 };
/** Between failed updates: each asks the server again, and may download a build, so not too often. */
const UPDATE_BACKOFF: Backoff = { initialMs: 5_000, maxMs: 300_000 };

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
  /** Called when the server answers the hello with `update` (ADR-025). The client dials nothing meanwhile.
   * It installs the build and resolves, and the client stops (the node restarts on the build), or rejects,
   * and the client asks the server again after `updateBackoff`. Without it this node cannot update itself,
   * which is reported as a refusal. */
  onUpdate?: (update: BuildUpdate) => Promise<void>;
  /** Between failed updates (`UPDATE_BACKOFF`: 5 s doubling to 5 min, with the same jitter). */
  updateBackoff?: Backoff;
}

/** What a node's connections announce beyond its node ID: its key (a paired node's) and its build (a bundle's). */
export interface NodeDialOptions extends LinkOptions {
  identity?: NodeIdentity;
  buildId?: string;
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
 * failed authentication) stops it instead: it never dials again and reports the refusal (`onRefused`). A
 * hello answered `update` hands the build to `onUpdate` and dials nothing until it fails (then backs off).
 * Every connection is a new attach: the node announces its live sessions and drops its credential cache
 * (see node-transport.md *Details: reconnecting*). `connectLocalNode` and `connectRemoteNode` are this
 * over the Unix socket and the WebSocket.
 */
export function redialNode(node: Node, dial: Dial, nodeId: string, link: NodeDialOptions, options: RedialOptions = {}): NodeLinkClient {
  const { backoff = RECONNECT_BACKOFF, updateBackoff = UPDATE_BACKOFF, random = Math.random, onStatus, onRefused, onUpdate } = options;
  const timers = link.timers ?? systemTimers;
  let stopped = false;
  let updating = false;
  let attempt = 0;
  let updateFailures = 0;
  let timer: unknown;
  let current: { close(): void } | undefined;
  const delay = ({ initialMs, maxMs }: Backoff, failures: number) => {
    const ceiling = Math.min(maxMs, initialMs * 2 ** failures);
    return ceiling / 2 + random() * ceiling / 2;
  };
  /** Dials again after `ms`, by default the next reconnect backoff; not while an update runs. */
  const schedule = (ms?: number) => {
    if (stopped || updating || timer !== undefined) return;
    timer = timers.setTimeout(() => { timer = undefined; void connect(); }, ms ?? delay(backoff, attempt++));
  };
  const refuse = (message: string) => {
    stop();
    if (onRefused) onRefused(message);
    else console.warn(`[node] refused by the server: ${message}; not reconnecting`);
  };
  /** The server runs another build: install it (dialing nothing meanwhile), and ask again later if that fails. */
  const update = (target: BuildUpdate) => {
    if (!onUpdate) { refuse(`The server runs build ${target.buildId.slice(0, 12)}, and this node cannot update itself`); return; }
    updating = true;
    if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
    onUpdate(target).then(() => stop(), (error: unknown) => {
      updating = false;
      if (stopped) return;
      const ms = delay(updateBackoff, updateFailures++);
      console.warn(`[node] updating to build ${target.buildId.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}; asking the server again in ${Math.round(ms / 1000)} s`);
      schedule(ms);
    });
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
      updateFailures = 0;
      if (wire.closed) return;
      negotiated = true;
      onStatus?.("connected");
    }, (error: unknown) => {
      if (stopped) return;
      if (error instanceof UpdateRequired) { update(error.update); return; }
      // The server will not serve this node: redialing cannot help.
      if (error instanceof RpcFailure && error.code === NODE_REFUSED) { refuse(error.message); return; }
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
