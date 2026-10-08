/**
 * Nodes Store
 *
 * Owns the settings panel's node list, the pairing code just created for a
 * new node, and revocation. The code is held only until dismissed: the
 * server keeps its hash, so it can never be fetched again.
 */

import type { NodeView } from "@backend/routes/nodes.js";
import { api } from "../api.js";
import { Loadable } from "../../helpers/loadable.js";

export type NodesStoreResult = { ok: true } | { error: string };
export type NodeStatus = "connected" | "offline" | "revoked";

export interface PairingCode {
  code: string;
  expiresAt: string;
}

/** Whether the node can connect: a revoked node is refused whatever its link. */
export function nodeStatus(node: NodeView): NodeStatus {
  if (node.revokedAt) return "revoked";
  return node.connected ? "connected" : "offline";
}

/** Only a paired node can be revoked: the local node was never paired, and is authorized by its socket. */
export function isRevocable(node: NodeView): boolean {
  return node.paired && !node.revokedAt;
}

export class NodesStore {
  nodes: Loadable<NodeView[]> = Loadable.idle();
  pairingCode: PairingCode | null = null;
  creatingPairingCode = false;

  private _listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  async load(): Promise<NodesStoreResult> {
    this.nodes = this.nodes.asLoading();
    this.notify();

    try {
      this.nodes = this.nodes.asLoaded(await api.nodes.list());
      return { ok: true };
    } catch (err: unknown) {
      const error = errorMessage(err);
      this.nodes = this.nodes.asError(error);
      return { error };
    } finally {
      this.notify();
    }
  }

  /** A single-use code for a new node, named `name` (else its hostname once paired). */
  async createPairingCode(name: string): Promise<NodesStoreResult> {
    this.creatingPairingCode = true;
    this.notify();

    try {
      const trimmed = name.trim();
      this.pairingCode = await api.nodes.createPairingCode(trimmed ? { name: trimmed } : {});
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.creatingPairingCode = false;
      this.notify();
    }
  }

  dismissPairingCode() {
    if (!this.pairingCode) return;
    this.pairingCode = null;
    this.notify();
  }

  async revoke(nodeId: string): Promise<NodesStoreResult> {
    try {
      const revoked = await api.nodes.revoke(nodeId);
      const nodes = this.nodes.data;
      if (nodes) this.nodes = this.nodes.asLoaded(nodes.map((node) => node.id === revoked.id ? revoked : node));
      this.notify();
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
