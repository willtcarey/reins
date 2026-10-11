/**
 * One node (`NodeModel`): what the server asks of a node as a whole, rather than of one of its sessions or
 * sources, its view (`NodeView`) and the errors it throws. The collection is `Nodes` (nodes.ts).
 */
import type { Nodes } from "./nodes.js";
import type { NodeBuild } from "../state.js";
import { listSourcesOnNode, setNodeName, setNodeRemoved, setNodeRevoked, type NodeRow } from "../node-store.js";
import { getDb } from "../db.js";
import { nodeRefusal } from "../errors.js";
import { sessionRuns } from "../sessions/session-runs.js";
import { sessionNode } from "../sessions/session-ownership.js";
import { closeSessionRuntime, sessionProcess } from "../session-runtime/live.js";
import { getSession } from "../session-store.js";

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

/** How a run in progress on a node being removed ends. */
const REMOVED_RUN_INTERRUPTED = "The run was interrupted: its node was removed";

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

/** The node was removed: it may not connect, and it is no longer renamed, revoked or reloaded. Its record
 * stays, for its sessions (sessions hang off its sources). */
export class NodeRemovedError extends Error {
  constructor(nodeId: string) {
    super(`Node removed: ${nodeId}`);
    this.name = "NodeRemovedError";
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
   * of the raw Ed25519 key): null for a node never paired. A revoked or removed node keeps its key;
   * `assertMayConnect` refuses it. */
  get publicKey(): string | null { return this.row.publicKey; }

  /** Whether the node was removed (`remove`). */
  get removed(): boolean { return this.row.removedAt !== null; }

  /** Throws `NodeRemovedError` for a removed node and `NodeRevokedError` for a revoked one: the one check of
   * removal and revocation, made at every hello. */
  assertMayConnect(): void {
    this.assertNotRemoved();
    if (this.row.revokedAt) throw new NodeRevokedError(this.id);
  }

  view(): NodeView {
    const { publicKey, removedAt: _removedAt, ...node } = this.row;
    const remote = this.nodes.hub.get(this.id);
    return { ...node, paired: publicKey !== null, connected: remote.connected, sources: this.sources(), build: remote.build };
  }

  /** Its projects' sources, by path. */
  private sources(): NodeSourceView[] {
    return listSourcesOnNode(this.id).map(source => ({ path: source.path, project: { id: source.projectId, name: source.projectName, sourceId: source.id } }));
  }

  /**
   * Asks the node to reload (ADR-021) and resolves once the reload is scheduled, before it happens: the
   * node lets its running commands exit (refusing new ones meanwhile), then restarts on its new code; the
   * runs' tool calls wait for it (ADR-029). `force` cuts off commands still running at the node's drain
   * bound instead of cancelling the reload. Throws `NodeRefusedError` when the node refuses (nothing
   * would restart it, its new code does not build), and the call's `RpcFailure` (`unavailable`) when it is
   * not connected.
   */
  async reload({ force = false }: { force?: boolean } = {}): Promise<{ scheduled: true }> {
    this.assertNotRemoved();
    try {
      return await this.nodes.hub.get(this.id).request("node.reload", { force }, { timeoutMs: RELOAD_TIMEOUT_MS });
    } catch (error) {
      const refusal = nodeRefusal(error);
      if (refusal) throw new NodeRefusedError(refusal.message);
      throw error;
    }
  }

  /** Renames the node, any node, the local one included, to `name` trimmed. Tells browsers; returns its view.
   * Throws `InvalidNodeNameError` and `NodeRemovedError`. */
  rename(name: string): NodeView {
    this.assertNotRemoved();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NODE_NAME_LENGTH) throw new InvalidNodeNameError();
    setNodeName(this.id, trimmed);
    this.nodes.publish(this.id);
    return this.nodes.get(this.id).view();
  }

  /**
   * Revokes the paired node: records when (revoking again keeps the first time) and closes its link; its
   * hello is refused on every later connection. Tells browsers; returns its view. Throws
   * `NodeNotPairedError` and `NodeRemovedError`.
   */
  revoke(): NodeView {
    this.assertNotRemoved();
    this.assertPaired("revoked");
    setNodeRevoked(this.id, new Date().toISOString());
    this.nodes.hub.disconnect(this.id);
    this.nodes.publish(this.id);
    return this.nodes.get(this.id).view();
  }

  /**
   * Removes the paired node, revoked or not, abandoning it: records when and closes its link. Its row stays,
   * key included, so its sources and their sessions stay: readable, and movable to another node. From then
   * on its hello is refused (`assertMayConnect`), it is no longer listed or offered, its sources are no
   * project's default, and work for its sessions is refused (`Sessions.submit`). The live runtimes of its
   * sessions are closed, aborting their runs (tool calls waiting for the node fail); runs the server still
   * sees in progress there without one are settled as interrupted. Removing it again changes nothing.
   * Tells browsers. Throws `NodeNotFoundError` and `NodeNotPairedError`.
   */
  async remove(): Promise<void> {
    const removed = getDb().transaction(() => {
      const node = this.nodes.get(this.id);
      node.assertPaired("removed");
      if (node.removed) return false;
      setNodeRemoved(this.id, new Date().toISOString());
      return true;
    })();
    if (!removed) return;
    this.nodes.hub.disconnect(this.id);
    this.nodes.publish(this.id);
    const host = sessionProcess(this.nodes.state);
    const live = new Set([...host.sessions.live.keys()].filter(sessionId => {
      const row = getSession(sessionId);
      return !!row && sessionNode(row) === this.id;
    }));
    await Promise.all([...live].map(sessionId => closeSessionRuntime(host, sessionId)));
    await sessionRuns({ broadcast: this.nodes.broadcast, state: this.nodes.state }).interruptRunsOn(this.id, REMOVED_RUN_INTERRUPTED, live);
  }

  private assertNotRemoved(): void {
    if (this.removed) throw new NodeRemovedError(this.id);
  }

  /** The seeded local node was never paired: there is nothing to revoke, and it is not removed. */
  private assertPaired(action: "revoked" | "removed"): void {
    if (!this.row.publicKey) throw new NodeNotPairedError(this.id, action);
  }
}
