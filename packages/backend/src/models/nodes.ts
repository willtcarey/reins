/**
 * The server's nodes (`Nodes`): listing them, finding one (`NodeNotFoundError`), how browsers learn of
 * changes to nodes (`Nodes.publish`) and pairing new ones (`Nodes.pairing()`, node-pairing.ts).
 */
import type { NodeHub } from "../state.js";
import type { Broadcast } from "./broadcast.js";
import { getNode, listNodes } from "../node-store.js";
import { NodeModel, type NodeView } from "./node.js";
import { NodePairing } from "./node-pairing.js";

export class NodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
    this.name = "NodeNotFoundError";
  }
}

/** The server's nodes: `hub` holds their links, and `broadcast` tells browsers of changes. */
export class Nodes {
  constructor(readonly hub: NodeHub, private readonly broadcast: Broadcast) {}

  /** Every node as the API sees it, in name order. */
  list(): NodeView[] {
    return listNodes().map(row => new NodeModel(this, row).view());
  }

  /** Node `nodeId`; throws `NodeNotFoundError` for an unknown node. */
  get(nodeId: string): NodeModel {
    const row = getNode(nodeId);
    if (!row) throw new NodeNotFoundError(nodeId);
    return new NodeModel(this, row);
  }

  /** Tells browsers node `nodeId` as it is now (`node_updated`, with the pairing code that just paired it if
   * any), or that it is gone (`node_removed`). */
  publish(nodeId: string, { pairingCodeId }: { pairingCodeId?: number } = {}): void {
    const row = getNode(nodeId);
    if (!row) this.broadcast({ type: "node_removed", nodeId });
    else this.broadcast({ type: "node_updated", node: new NodeModel(this, row).view(), ...(pairingCodeId === undefined ? {} : { pairingCodeId }) });
  }

  /** Pairing codes and their redemption. */
  pairing(): NodePairing {
    return new NodePairing(this);
  }
}
