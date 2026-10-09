/**
 * The server's nodes (`Nodes`) and one node (`NodeModel`): what the server asks of a node as a whole, rather
 * than of one of its sessions or checkouts, and how browsers learn of changes to nodes (`Nodes.publish`).
 * Pairing new nodes is `Nodes.pairing()` (node-pairing.ts).
 */
import type { NodeHub } from "../state.js";
import type { Broadcast } from "./broadcast.js";
import { deleteNode, getNode, listNodes, projectsWithSourcesOn, setNodeRevoked, type NodeRow } from "../node-store.js";
import { getDb } from "../db.js";
import { nodeRefusal } from "../errors.js";
import { NodePairing } from "./node-pairing.js";

/** A node as the API and browsers see it: whether it is connected now, and whether it was paired (it has
 * a key, which the view never carries). */
export interface NodeView { id: string; name: string; connected: boolean; paired: boolean; hostname: string | null; pairedAt: string | null; revokedAt: string | null }

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

/** One node, as its row was when it was read (`Nodes.get`). */
export class NodeModel {
  constructor(private readonly nodes: Nodes, readonly row: NodeRow) {}

  get id(): string { return this.row.id; }

  view(): NodeView {
    const { publicKey, ...node } = this.row;
    return { ...node, paired: publicKey !== null, connected: this.nodes.hub.get(this.id).connected };
  }

  /**
   * Asks the node to reload (ADR-021) and resolves once the reload is scheduled, before it happens: the
   * node holds every run at its next pause point, restarts on its new code once nothing is in flight, and
   * the server resumes the runs when it reconnects. `force` cuts off what is still in flight at the node's
   * drain bound instead of cancelling the reload. Throws `NodeRefusedError` when the node refuses (nothing
   * would restart it, its new code does not build), and the call's `RpcFailure` (`unavailable`) when it is
   * not connected.
   */
  async reload({ force = false }: { force?: boolean } = {}): Promise<{ scheduled: true }> {
    try {
      return await this.nodes.hub.get(this.id).request("node.reload", { force }, { timeoutMs: RELOAD_TIMEOUT_MS });
    } catch (error) {
      const refusal = nodeRefusal(error);
      if (refusal) throw new NodeRefusedError(refusal.message);
      throw error;
    }
  }

  /**
   * Revokes the paired node: records when (revoking again keeps the first time) and closes its link; its
   * hello is refused on every later connection. Tells browsers; returns its view. Throws
   * `NodeNotPairedError`.
   */
  revoke(): NodeView {
    this.assertPaired("revoked");
    setNodeRevoked(this.id, new Date().toISOString());
    this.nodes.hub.disconnect(this.id);
    this.nodes.publish(this.id);
    return this.nodes.get(this.id).view();
  }

  /**
   * Removes the paired node, revoked or not: closes its link and deletes it, so its key is gone and it is
   * refused from then on; its pairing grant forgets it. A node that still holds sources is kept (sessions
   * hang off sources; this never deletes either). The row is read again in the deleting transaction, so
   * what it checks is current. Tells browsers. Throws `NodeNotFoundError`, `NodeNotPairedError` and
   * `NodeInUseError`.
   */
  remove(): void {
    getDb().transaction(() => {
      const node = this.nodes.get(this.id);
      node.assertPaired("removed");
      const projects = projectsWithSourcesOn(this.id);
      if (projects.length > 0) throw new NodeInUseError(node.row.name, projects);
      deleteNode(this.id);
    })();
    this.nodes.hub.disconnect(this.id);
    this.nodes.publish(this.id);
  }

  /** The seeded local node was never paired: there is nothing to revoke, and it is not removed. */
  private assertPaired(action: "revoked" | "removed"): void {
    if (!this.row.publicKey) throw new NodeNotPairedError(this.id, action);
  }
}
