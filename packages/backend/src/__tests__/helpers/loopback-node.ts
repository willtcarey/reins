/**
 * In-memory loopback node: TEST UTILITY ONLY.
 *
 * Production runs the node in its own process, reached over the local Unix socket; the server never
 * starts one. Tests that need both sides in one process start the node here and link it over an
 * in-memory socket pair through the same server transport and handlers (`internalNodeServer`) a socket
 * connection uses. `createServerState()` registers it lazily: the node starts on the first command and
 * the link is recreated after it closes (as the node process would redial).
 */
import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair, RpcFailure } from "@reins/node/protocol";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { internalNodeServer, setInternalNodeConnectorForTesting, closeInternalNodeLink, type InternalLink } from "../../runtimes/internal-node.js";
import type { ServerState } from "../../state.js";

const nodes = new WeakMap<ServerState, Node>();

function connectLoopback(state: ServerState): InternalLink {
  let node = nodes.get(state);
  if (!node) { node = startNode(); nodes.set(state, node); }
  const [serverEnd, nodeEnd] = createLoopbackPair();
  // In-process frames are uncapped: committed batches are never split.
  const uncapped = { maxFrameBytes: Infinity };
  const server = createServerTransport(serverEnd, internalNodeServer(state), uncapped);
  const connection = connectNode(node, nodeEnd, "internal", uncapped);
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  const ready = connection.ready.catch((error: unknown) => {
    throw new RpcFailure("unavailable", `Internal node negotiation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  ready.catch(() => undefined);
  return {
    closed: () => serverEnd.closed,
    close: () => serverEnd.close(),
    async client() { await ready; return server; },
  };
}

/** Links `state` to an in-process node on first use (see module doc), or now with `linkNow`. */
export function useLoopbackNode(state: ServerState, { linkNow = false } = {}): void {
  setInternalNodeConnectorForTesting(state, () => connectLoopback(state), { linkNow });
}

/** The in-process node for `state`, started and linked if needed: node→server calls (replica,
 * attachments, lifecycle reports) need a live link even before any command is sent. */
export function internalNodeFor(state: ServerState): Node {
  useLoopbackNode(state, { linkNow: true });
  return nodes.get(state)!;
}

/** Closes the link and releases the node; the next command starts a fresh one. */
export function stopInternalNode(state: ServerState): void {
  closeInternalNodeLink(state);
  nodes.get(state)?.stop();
  nodes.delete(state);
}
