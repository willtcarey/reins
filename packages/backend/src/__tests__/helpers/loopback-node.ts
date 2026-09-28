/**
 * In-memory loopback node: TEST UTILITY ONLY.
 *
 * Production runs each node in its own process, reached over a socket; the server never starts one.
 * Tests that need both sides in one process start a node here and connect it over an in-memory socket
 * pair through the hub's real `accept` path (the same one a socket connection takes), announcing a node
 * ID in `node.hello` like the node process. When a negotiated link closes the node redials (as the node
 * process would), reaching whichever hub the state has then, until it is stopped.
 */
import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createNodeConnection, protocolVersion, type NodeCommandHandlers, type Ready } from "@reins/node/protocol";
import { createLoopbackPair, scriptedCommandHandlers, type LoopbackSocket } from "@reins/node/testing";
import type { Database } from "bun:sqlite";
import { testNodeDb } from "./test-db.js";
import type { NodeSocket, ServerState } from "../../state.js";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { nodeServerHandlers } from "../../runtimes/node-server-handlers.js";
import { nodeServerServices } from "../../runtimes/node-hub.js";

/** The node ID the seeded node row (and the local node process by default) uses. */
export const SEEDED_NODE_ID = "internal";

/** In-process frames are uncapped: committed batches are never split. */
const UNCAPPED = { maxFrameBytes: Infinity };

export interface LoopbackLink {
  /** Resolves once the current connection negotiated. */
  ready(): Promise<Ready>;
  /** Closes the current connection from the server's end; the node redials (unless `redial: false`). */
  drop(): void;
  /** Closes the current connection and dials again now. */
  redial(): void;
  /** Closes the connection and stops redialing. */
  stop(): void;
}

const dialed = new WeakMap<ServerState, Set<LoopbackLink>>();

/** Waits for every loopback link of `state` to negotiate (refused ones are skipped), then wakes the hub
 * and resolves once no delivery is in progress. */
export async function drainCommands(state: ServerState): Promise<void> {
  await Promise.all([...dialed.get(state) ?? []].map(link => link.ready().catch(() => undefined)));
  await state.nodes.wake();
}

export interface DialOptions {
  /** Redial when a negotiated connection closes (default), as the node process does. */
  redial?: boolean;
  /** The server end as the hub sees it, e.g. a proxy that intercepts frames. */
  serverSocket?: (serverEnd: LoopbackSocket) => NodeSocket;
}

/**
 * Connects a node end to `state.nodes` over an in-memory socket pair, through the hub's `accept`: `open`
 * wires the node side of each connection (`connectNode` for a real node, `createNodeConnection` for a
 * scripted one), which announces its node ID.
 */
export function dialLoopback(state: ServerState, open: (socket: LoopbackSocket) => { receive(data: string): void; close(): void; ready: Promise<Ready> }, { redial = true, serverSocket = end => end }: DialOptions = {}): LoopbackLink {
  let stopped = false;
  let current: { serverEnd: LoopbackSocket; ready: Promise<Ready>; replaced?: boolean } | undefined;
  const dial = () => {
    const [serverEnd, nodeEnd] = createLoopbackPair();
    state.nodes.accept(serverSocket(serverEnd), UNCAPPED);
    // A closed hub refuses the connection at once, like a dial nothing accepts: not redialed.
    if (serverEnd.closed) { current = { serverEnd, ready: Promise.reject(new Error("Connection refused")) }; current.ready.catch(() => undefined); return; }
    const connection = open(nodeEnd);
    let negotiated = false;
    nodeEnd.onmessage = connection.receive;
    const attempt = { serverEnd, ready: connection.ready.then(value => { negotiated = true; return value; }), replaced: false };
    attempt.ready.catch(() => undefined);
    nodeEnd.onclose = () => {
      connection.close();
      // A connection that never negotiated (refused, or its hub closed) is not redialed.
      if (redial && !stopped && negotiated && !attempt.replaced) setTimeout(() => { if (!stopped) dial(); }, 0);
    };
    current = attempt;
  };
  dial();
  const links = dialed.get(state) ?? new Set<LoopbackLink>();
  dialed.set(state, links);
  const link: LoopbackLink = {
    ready: () => current!.ready,
    drop: () => current?.serverEnd.close(),
    redial() { if (current) { current.replaced = true; current.serverEnd.close(); } dial(); },
    stop() { stopped = true; links.delete(link); current?.serverEnd.close(); },
  };
  links.add(link);
  return link;
}

interface Loopback { node: Node; link: LoopbackLink }
const loopbacks = new WeakMap<ServerState, Map<string, Loopback>>();

/** Starts an in-process node on `db` (the current test node database by default) and connects it to
 * `state` as `nodeId` (the seeded node by default). */
export function connectLoopbackNode(state: ServerState, { nodeId = SEEDED_NODE_ID, db }: { nodeId?: string; db?: Database } = {}): Node {
  const node = startNode(db ?? testNodeDb());
  const link = dialLoopback(state, socket => connectNode(node, socket, nodeId, UNCAPPED));
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

/** Disconnects the node and shuts it down (aborting runs, closing runtimes). Await it before closing the
 * node database. `loopbackNodeFor` starts a fresh node afterwards. */
export async function stopLoopbackNode(state: ServerState, nodeId = SEEDED_NODE_ID): Promise<void> {
  const loopback = loopbacks.get(state)?.get(nodeId);
  loopbacks.get(state)?.delete(nodeId);
  loopback?.link.stop();
  await loopback?.node.shutdown();
}

/** A scripted node end (no Node, no storage): `handlers` answer the session commands it advertises. */
export function connectScriptedNode(state: ServerState, nodeId: string, handlers: Partial<NodeCommandHandlers>): LoopbackLink {
  const capabilities = Object.keys(handlers).map(name => `session.${name}`);
  return dialLoopback(state, socket => createNodeConnection(socket, { nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities, ...UNCAPPED, ...scriptedCommandHandlers(handlers) }));
}

/** A negotiated server transport to `node` that no hub knows of, serving the same handlers a hub link
 * would: for tests that send arbitrary wire params (`sendNodeCommand`). The node attaches it as its
 * newest connection. */
export async function directLink(state: ServerState, node: Node, nodeId = SEEDED_NODE_ID) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const services = nodeServerServices(state);
  const transport = createServerTransport(serverEnd, id => nodeServerHandlers(id, services), UNCAPPED);
  serverEnd.onmessage = transport.receive; serverEnd.onclose = transport.close;
  const connection = connectNode(node, nodeEnd, nodeId, UNCAPPED);
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  await transport.negotiated;
  return transport;
}
