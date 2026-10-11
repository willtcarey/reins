/**
 * In-memory loopback node: TEST UTILITY ONLY.
 *
 * Production runs each node in its own process, reached over a socket; the server never starts one.
 * Tests that need both sides in one process link a node (a real one, `startNode`, or a stand-in,
 * `scriptedNode`) with the node's own `connectNode` over an in-memory transport whose every connection
 * goes through the hub's real `accept` path (the same one a socket connection takes), announcing a node ID
 * in `node.hello` like the node process. When a negotiated link closes the node redials as the node
 * process does (at once here), reaching whichever hub the state has then, until it is stopped.
 */
import { startNode, type Node, type NodeCommands } from "@reins/node/node";
import { connectNode, type Transport } from "@reins/node/node-connection";
import { scriptedNode } from "@reins/node/testing";
import type { BuildUpdate, LinkSocket, NodeKey } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import type { NodeHub, NodeSocket, ServerState } from "../../state.js";
import { SessionModel, type SessionContext } from "../../models/session.js";
import { getSession } from "../../session-store.js";
import { getSource } from "../../node-store.js";

/** The node ID the seeded node row (and the local node process by default) uses. */
export const SEEDED_NODE_ID = "internal";

export interface LoopbackLink {
  /** Resolves once the node is connected; rejects with a `LinkFailed` once it no longer dials. */
  ready(): Promise<void>;
  /** Closes the current connection from the server's end; the node redials (unless `redial: false`). */
  drop(): void;
  /** Stops the node's link: closes its connection and dials no more. */
  stop(): void;
}

/** Why a loopback link stopped dialing: the server refused the node (`message` is its reason), told it to
 * update (`update`), its connection closed without negotiating (the node logs why), or no hub took the
 * dial (the state's hub is closed). Only a refusal or an update stops a node process; the others stand in
 * for a node process's redials, which a test would otherwise wait on. */
export class LinkFailed extends Error {
  constructor(readonly reason: "refused" | "update" | "unnegotiated" | "unreachable", message: string, readonly update?: BuildUpdate) {
    super(message);
    this.name = "LinkFailed";
  }
}

const dialed = new WeakMap<ServerState, Set<LoopbackLink>>();

/** Waits for every loopback link of `state` to negotiate (failed ones are skipped), then wakes the hub
 * and resolves once no delivery is in progress. */
export async function drainCommands(state: ServerState): Promise<void> {
  await Promise.all([...dialed.get(state) ?? []].map(link => link.ready().catch(() => undefined)));
  await state.nodes.wake();
}

export interface DialOptions {
  /** The node ID it announces (the seeded node's by default). */
  nodeId?: string;
  /** A paired node's key, answering the hub's challenge. */
  key?: NodeKey;
  /** The node bundle it announces. */
  buildId?: string;
  /** Redial when a negotiated connection closes (default), as the node process does. */
  redial?: boolean;
  /** The server end as the hub sees it, e.g. a proxy that intercepts frames. */
  serverSocket?: (serverEnd: LinkSocket) => NodeSocket;
  /** The hub authenticates the connection (`node.authenticate`) for this origin, as a remote transport
   * would; by default it does not, as on the local socket. */
  authenticate?: { origin: string };
  /** The frame cap of both ends (uncapped by default). */
  maxFrameBytes?: number;
  /** The hub each dial reaches (`state.nodes` by default): a function, so a test replacing the handler
   * load can have the node redial the new load's hub, as the node process does. */
  hub?: () => NodeHub;
}

/**
 * Links `node` to `state.nodes` with `connectNode` over an in-memory transport: each dial is a loopback
 * socket pair whose server end goes to the hub's `accept`. No hello timeout or heartbeat; redials at once.
 */
export function dialLoopback(state: ServerState, node: Node, { nodeId = SEEDED_NODE_ID, key, buildId, redial = true, serverSocket = end => end, authenticate, maxFrameBytes = Infinity, hub = () => state.nodes }: DialOptions = {}): LoopbackLink {
  // `ready()`: settled once the node connects or the link fails, pending again while it redials.
  let ready = Promise.withResolvers<void>();
  ready.promise.catch(() => undefined);
  let settled = false;
  const pending = () => {
    if (!settled) return;
    ready = Promise.withResolvers<void>();
    ready.promise.catch(() => undefined);
    settled = false;
  };
  const settle = (error?: LinkFailed) => {
    pending();
    settled = true;
    if (error) ready.reject(error); else ready.resolve();
  };
  let serverEnd: LinkSocket | undefined;
  let dials = 0;
  let negotiatedSinceDial = false;
  let handle: { stop(): void } | undefined;
  let stopping = false;
  const stopLink = () => { stopping = true; handle?.stop(); };
  const fail = (error: LinkFailed) => { stopLink(); settle(error); };
  const transport: Transport = {
    address: "loopback",
    link: { maxFrameBytes },
    async open(opened) {
      // A connection that never negotiated (its hub closed mid-hello, or a hello failed) is not redialed.
      if (dials++ > 0 && !negotiatedSinceDial) { fail(new LinkFailed("unnegotiated", "The connection closed without negotiating")); throw new Error("Not redialed"); }
      negotiatedSinceDial = false;
      const [server, nodeEnd] = createLoopbackPair();
      hub().accept(serverSocket(server), { maxFrameBytes, ...(authenticate ? { authenticate } : {}) });
      // A closed hub refuses the connection at once, like a dial nothing accepts: not redialed.
      if (server.closed) { fail(new LinkFailed("unreachable", "Connection refused")); throw new Error("Connection refused"); }
      serverEnd = server;
      opened(nodeEnd);
    },
  };
  handle = connectNode(node, transport, {
    nodeId, ...(key ? { key } : {}), ...(buildId ? { buildId } : {}),
    onState(link) {
      if (link.state === "connected") { negotiatedSinceDial = true; settle(); }
      // Not redialing, `ready()` stays as it was, resolved.
      else if (link.state === "connecting") { if (redial) pending(); else stopLink(); }
      else fail(new LinkFailed("refused", link.message));
    },
    async onUpdate(update) { fail(new LinkFailed("update", `Told to update to build ${update.buildId}`, update)); },
  }, { backoff: { initialMs: 0, maxMs: 0 } });
  if (stopping) handle.stop();
  const links = dialed.get(state) ?? new Set<LoopbackLink>();
  dialed.set(state, links);
  const link: LoopbackLink = {
    ready: () => ready.promise,
    drop: () => serverEnd?.close(),
    stop() { links.delete(link); stopLink(); },
  };
  links.add(link);
  return link;
}

interface Loopback { node: Node; link: LoopbackLink }
const loopbacks = new WeakMap<ServerState, Map<string, Loopback>>();

/** Starts an in-process node and connects it to `state` as `nodeId` (the seeded node by default). */
export function connectLoopbackNode(state: ServerState, { nodeId = SEEDED_NODE_ID, key, authenticate }: Pick<DialOptions, "nodeId" | "key" | "authenticate"> = {}): Node {
  const node = startNode();
  const link = dialLoopback(state, node, { nodeId, key, authenticate });
  const byNode = loopbacks.get(state) ?? new Map<string, Loopback>();
  loopbacks.set(state, byNode);
  byNode.set(nodeId, { node, link });
  return node;
}

/** The loopback node connected to `state` as `nodeId`, started and connected if none is. */
export function loopbackNodeFor(state: ServerState, nodeId = SEEDED_NODE_ID): Node {
  return loopbacks.get(state)?.get(nodeId)?.node ?? connectLoopbackNode(state, { nodeId });
}

/** The loopback link of `nodeId` (throws if none was connected). */
export function loopbackLink(state: ServerState, nodeId = SEEDED_NODE_ID): LoopbackLink {
  const loopback = loopbacks.get(state)?.get(nodeId);
  if (!loopback) throw new Error(`No loopback node ${nodeId}`);
  return loopback.link;
}

/** Disconnects the node and shuts it down (closing runtimes, leaving runs pending). Await it before closing the
 * server database. `loopbackNodeFor` starts a fresh node afterwards. */
export async function stopLoopbackNode(state: ServerState, nodeId = SEEDED_NODE_ID): Promise<void> {
  const loopback = loopbacks.get(state)?.get(nodeId);
  loopbacks.get(state)?.delete(nodeId);
  loopback?.link.stop();
  await loopback?.node.shutdown();
}

/** A stand-in node (`scriptedNode`: no Pi, no storage) linked to `state` as `nodeId`: `commands` answer as
 * scripted, and any other command fails. It announces no live sessions: runs the server sees on this node
 * are resumed, or settled as interrupted when its `resumePending` fails or finds nothing. */
export function connectScriptedNode(state: ServerState, nodeId: string, commands: Partial<NodeCommands>, { key, authenticate, redial }: Pick<DialOptions, "key" | "authenticate" | "redial"> = {}): LoopbackLink {
  return dialLoopback(state, scriptedNode(commands), { nodeId, key, authenticate, redial });
}

/** The session's context as its node gets it now (`SessionModel.context` in its source), for tests
 * that drive a node directly. */
export function sessionContextOf(sessionId: string): SessionContext {
  const row = getSession(sessionId)!;
  return new SessionModel(row).context(getSource(row.source_id)!);
}
