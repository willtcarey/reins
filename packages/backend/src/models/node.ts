/**
 * One node (`NodeModel`): what the server asks of a node as a whole, rather than of one of its sessions or
 * sources, its view (`NodeView`) and the errors it throws. The collection is `Nodes` (nodes.ts).
 */
import type { Nodes } from "./nodes.js";
import type { NodeBuild } from "../state.js";
import { deleteNode, listSourcesOnNode, projectsWithSourcesOn, setNodeName, setNodeRevoked, type NodeRow } from "../node-store.js";
import { getDb } from "../db.js";
import { nodeRefusal } from "../errors.js";

/** A node as the API and browsers see it: whether it is connected now, whether it was paired (it has a
 * key, which the view never carries), its projects' sources on it (Settings shows how many, `reins source
 * list` lists them), and the node bundle it runs, as it announced it to this server (`NodeBuild`; null from
 * source, or when unknown). */
export interface NodeView { id: string; name: string; connected: boolean; paired: boolean; hostname: string | null; pairedAt: string | null; revokedAt: string | null; sources: NodeSourceView[]; build: NodeBuild | null }

/** One of a node's sources: a project's working copy on it (the server's sources are the only record of
 * them, ADR-026). */
export interface NodeSourceView { path: string; project: { id: number; name: string; sourceId: number } }

/** The node checks that its new code builds before it answers. */
const RELOAD_TIMEOUT_MS = 30_000;

/** The longest name a node may be given. */
export const MAX_NODE_NAME_LENGTH = 100;

/** A node name must have 1 to `MAX_NODE_NAME_LENGTH` characters once trimmed. */
export class InvalidNodeNameError extends Error {
  constructor() {
    super(`A node name must have 1 to ${MAX_NODE_NAME_LENGTH} characters`);
    this.name = "InvalidNodeNameError";
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

/** The node was revoked: it may not connect, whatever transport carries it and whatever key it holds. */
export class NodeRevokedError extends Error {
  constructor(nodeId: string) {
    super(`Node revoked: ${nodeId}`);
    this.name = "NodeRevokedError";
  }
}

/** The node's refusal of a request, as it worded it. */
export class NodeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeRefusedError";
  }
}

/** One node, as its row was when it was read (`Nodes.get`). */
export class NodeModel {
  constructor(private readonly nodes: Nodes, readonly row: NodeRow) {}

  get id(): string { return this.row.id; }

  /** The key the node was paired with, which a connection authenticating as it must prove it holds (base64url
   * of the raw Ed25519 key): null for a node never paired. A revoked node keeps its key; `assertMayConnect`
   * refuses it. */
  get publicKey(): string | null { return this.row.publicKey; }

  /** Throws `NodeRevokedError` for a revoked node: the one check of revocation, made at every hello. */
  assertMayConnect(): void {
    if (this.row.revokedAt) throw new NodeRevokedError(this.id);
  }

  view(): NodeView {
    const { publicKey, ...node } = this.row;
    const remote = this.nodes.hub.get(this.id);
    return { ...node, paired: publicKey !== null, connected: remote.connected, sources: this.sources(), build: remote.build };
  }

  /** Its projects' sources, by path. */
  private sources(): NodeSourceView[] {
    return listSourcesOnNode(this.id).map(source => ({ path: source.path, project: { id: source.projectId, name: source.projectName, sourceId: source.id } }));
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

  /** Renames the node, any node, the local one included, to `name` trimmed. Tells browsers; returns its view.
   * Throws `InvalidNodeNameError`. */
  rename(name: string): NodeView {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NODE_NAME_LENGTH) throw new InvalidNodeNameError();
    setNodeName(this.id, trimmed);
    this.nodes.publish(this.id);
    return this.nodes.get(this.id).view();
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
