/**
 * The server's nodes (`Nodes`): listing them, finding one (`NodeNotFoundError`), how browsers learn of
 * changes to nodes (`Nodes.publish`) and pairing new ones (`Nodes.pairing()`, node-pairing.ts).
 */
import type { AppState, NodeHub } from "../state.js";
import type { Broadcast } from "./broadcast.js";
import { getNode, listNodes } from "../node-store.js";
import { NodeModel, type NodeView } from "./node.js";
import { NodePairing } from "./node-pairing.js";

export class NodeNotFoundError extends Error {
  constructor(nodeId: string, why?: string) {
    super(`Node not found: ${nodeId}${why ? ` (${why})` : ""}`);
    this.name = "NodeNotFoundError";
  }
}

/** The server's nodes: the state's hub holds their links, its sessions run on them, and `broadcast` tells
 * browsers of changes. */
export class Nodes {
  constructor(readonly state: AppState, readonly broadcast: Broadcast) {}

  get hub(): NodeHub { return this.state.nodes; }

  /** Every node as the API sees it, in name order; removed nodes are not listed. */
  list(): NodeView[] {
    return listNodes().map(row => new NodeModel(this, row).view());
  }

  /** Node `nodeId`, removed or not (its sessions still name it); throws `NodeNotFoundError` for an unknown
   * node. */
  get(nodeId: string): NodeModel {
    const row = getNode(nodeId);
    if (!row) throw new NodeNotFoundError(nodeId);
    return new NodeModel(this, row);
  }

  /** The node with ID `nodeIdOrName`, else the one not removed named `nodeIdOrName` (ignoring case).
   * Throws `NodeNotFoundError` for neither, and when several nodes have that name. */
  find(nodeIdOrName: string): NodeModel {
    const byId = getNode(nodeIdOrName);
    if (byId) return new NodeModel(this, byId);
    const named = listNodes().filter(node => node.name.toLowerCase() === nodeIdOrName.trim().toLowerCase());
    if (named.length > 1) throw new NodeNotFoundError(nodeIdOrName, `several nodes are named so (${named.map(node => node.id).join(", ")}): name one by its ID`);
    if (named.length === 0) throw new NodeNotFoundError(nodeIdOrName);
    return new NodeModel(this, named[0]);
  }

  /** Tells browsers node `nodeId` as it is now (`node_updated`, with the pairing code that just paired it if
   * any), or that it is gone (`node_removed`: removed, or unknown). */
  publish(nodeId: string, { pairingCodeId }: { pairingCodeId?: number } = {}): void {
    const row = getNode(nodeId);
    if (!row || row.removedAt !== null) this.broadcast({ type: "node_removed", nodeId });
    else this.broadcast({ type: "node_updated", node: new NodeModel(this, row).view(), ...(pairingCodeId === undefined ? {} : { pairingCodeId }) });
  }

  /** Pairing codes and their redemption. */
  pairing(): NodePairing {
    return new NodePairing(this);
  }
}
