/**
 * What the server asks of a node as a whole, rather than of one of its sessions or checkouts, and how
 * browsers learn of changes to nodes (`node_updated`, `node_removed`; `node_paired` in node-pairing.ts).
 */
import type { NodeHub } from "../state.js";
import type { Broadcast } from "./broadcast.js";
import { deleteNode, getNode, getNodeDetails, projectsWithSourcesOn, setNodeRevoked, type NodeDetails } from "../node-store.js";
import { getDb } from "../db.js";
import { nodeRefusal } from "../errors.js";

/** A node as the API and browsers see it: its details and whether it is connected now. */
export type NodeView = NodeDetails & { connected: boolean };

/** What changing a node needs: the hub holding its link and the browsers to tell. */
export interface NodeServices { nodes: NodeHub; broadcast: Broadcast }

export const nodeView = (nodes: NodeHub, node: NodeDetails): NodeView => ({ ...node, connected: nodes.get(node.id).connected });

/** Tells browsers node `nodeId` as it is now (`node_updated`), unless it no longer exists. */
export function broadcastNodeUpdated({ nodes, broadcast }: NodeServices, nodeId: string): void {
  const node = getNodeDetails(nodeId);
  if (node) broadcast({ type: "node_updated", node: nodeView(nodes, node) });
}

/** The node checks that its new code builds before it answers. */
const RELOAD_TIMEOUT_MS = 30_000;

export class NodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
    this.name = "NodeNotFoundError";
  }
}

/** The node was never paired (the seeded local node): its socket's file permissions authorize it, so
 * there is nothing to revoke, and it is not removed. */
export class NodeNotPairedError extends Error {
  constructor(nodeId: string, action: "revoked" | "removed") {
    super(`Node was never paired and cannot be ${action}: ${nodeId}`);
    this.name = "NodeNotPairedError";
  }
}

/** The node still holds sources: their sessions run there, so it stays until they are gone. */
export class NodeInUseError extends Error {
  constructor(name: string, projects: string[]) {
    super(`${name} still holds sources of these projects: ${projects.join(", ")}`);
    this.name = "NodeInUseError";
  }
}

/** The node's refusal of a request, as it worded it. */
export class NodeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeRefusedError";
  }
}

/**
 * Asks node `nodeId` to reload (ADR-021) and resolves once the reload is scheduled, before it happens:
 * the node holds every run at its next pause point, restarts on its new code once nothing is in flight,
 * and the server resumes the runs when it reconnects. `force` cuts off what is still in flight at the
 * node's drain bound instead of cancelling the reload. Throws `NodeNotFoundError` for an unknown node,
 * `NodeRefusedError` when the node refuses (nothing would restart it, its new code does not build), and
 * the call's `RpcFailure` (`unavailable`) when it is not connected.
 */
export async function reloadNode(nodes: NodeHub, nodeId: string, { force = false }: { force?: boolean } = {}): Promise<{ scheduled: true }> {
  if (!getNode(nodeId)) throw new NodeNotFoundError(nodeId);
  try {
    return await nodes.get(nodeId).request("node.reload", { force }, { timeoutMs: RELOAD_TIMEOUT_MS });
  } catch (error) {
    const refusal = nodeRefusal(error);
    if (refusal) throw new NodeRefusedError(refusal.message);
    throw error;
  }
}

/**
 * Revokes paired node `nodeId`: records when (revoking again keeps the first time) and closes its link; its
 * hello is refused on every later connection. Tells browsers. Throws `NodeNotFoundError` and
 * `NodeNotPairedError`.
 */
export function revokeNode(services: NodeServices, nodeId: string): NodeView {
  const node = getNodeDetails(nodeId);
  if (!node) throw new NodeNotFoundError(nodeId);
  if (!node.paired) throw new NodeNotPairedError(nodeId, "revoked");
  setNodeRevoked(nodeId, new Date().toISOString());
  services.nodes.disconnect(nodeId);
  const view = nodeView(services.nodes, getNodeDetails(nodeId)!);
  services.broadcast({ type: "node_updated", node: view });
  return view;
}

/**
 * Removes paired node `nodeId`, revoked or not: closes its link and deletes it, so its key is gone and it
 * is refused from then on; its pairing grant forgets it. A node that still holds sources is kept (sessions
 * hang off sources; this never deletes either). Tells browsers. Throws `NodeNotFoundError`,
 * `NodeNotPairedError` and `NodeInUseError`.
 */
export function removeNode(services: NodeServices, nodeId: string): void {
  getDb().transaction(() => {
    const node = getNodeDetails(nodeId);
    if (!node) throw new NodeNotFoundError(nodeId);
    if (!node.paired) throw new NodeNotPairedError(nodeId, "removed");
    const projects = projectsWithSourcesOn(nodeId);
    if (projects.length > 0) throw new NodeInUseError(node.name, projects);
    services.nodes.disconnect(nodeId);
    deleteNode(nodeId);
  })();
  services.broadcast({ type: "node_removed", nodeId });
}
