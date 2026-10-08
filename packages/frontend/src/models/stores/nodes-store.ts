/**
 * Nodes Store
 *
 * Owns the settings page's node list, kept current from node messages
 * (`node_paired`, `node_updated`, `node_removed`), the pairing code just
 * created for a new node and how its pairing is going, revocation and
 * removal. The code is held only until dismissed: the server keeps its
 * hash, so it can never be fetched again.
 */

import type { NodeView } from "@backend/models/nodes.js";
import { api } from "../api.js";
import { Loadable } from "../../helpers/loadable.js";
import type { InboundEventSource } from "../ws-client.js";

export type NodesStoreResult = { ok: true } | { error: string };
export type NodeStatus = "connected" | "offline" | "revoked";

/** Runs `fn` after `ms`; returns a function that cancels it. Tests inject their own. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** How long a successful pairing is shown before the node list returns. */
export const PAIRED_DISPLAY_MS = 1500;

export interface PairingCode {
  id: number;
  code: string;
  expiresAt: string;
}

/**
 * A pairing code and how its pairing is going: `waiting` for a machine to redeem it, `paired` once one
 * did (as `node`), or `expired` unredeemed. `name` is the name it was created with ("" for the node's
 * hostname). A remote node cannot connect yet, so pairing ends at `paired`; waiting for its first
 * connection would come between `paired` and the end (see `_paired`).
 */
export type Pairing = PairingCode & { name: string } & (
  | { status: "waiting" }
  | { status: "paired"; node: NodeView }
  | { status: "expired" }
);

/** Whether the node can connect: a revoked node is refused whatever its link. */
export function nodeStatus(node: NodeView): NodeStatus {
  if (node.revokedAt) return "revoked";
  return node.connected ? "connected" : "offline";
}

/** Only a paired node can be revoked: the local node was never paired, and is authorized by its socket. */
export function isRevocable(node: NodeView): boolean {
  return node.paired && !node.revokedAt;
}

/** Only a paired node can be removed, revoked or not: the local node is never removed. */
export function isRemovable(node: NodeView): boolean {
  return node.paired;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** The nodes in the server's order: by name, then ID. */
const byName = (a: NodeView, b: NodeView) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export class NodesStore {
  nodes: Loadable<NodeView[]> = Loadable.idle();
  pairing: Pairing | null = null;
  creatingPairingCode = false;

  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;
  /** Cancels the pairing's pending timer: its expiry while waiting, its end once paired. */
  private _cancelPairingTimer: (() => void) | null = null;

  constructor(eventSource?: InboundEventSource, private _schedule: Schedule = defaultSchedule) {
    this._unsubscribe = eventSource?.subscribe({
      node_paired: (message) => {
        this._upsert(message.node);
        if (this.pairing?.id === message.pairingCodeId) this._paired(message.node);
        this.notify();
      },
      node_updated: (message) => {
        this._upsert(message.node);
        this.notify();
      },
      node_removed: (message) => {
        this._drop(message.nodeId);
        this.notify();
      },
    }) ?? null;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._setPairingTimer(null);
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

  /** A single-use code for a new node, named `name` (else its hostname once paired), waiting for its
   * machine until it expires. */
  async createPairingCode(name: string): Promise<NodesStoreResult> {
    this.creatingPairingCode = true;
    this.notify();

    try {
      const trimmed = name.trim();
      const created = await api.nodes.createPairingCode(trimmed ? { name: trimmed } : {});
      this.pairing = { ...created, name: trimmed, status: "waiting" };
      this._setPairingTimer(this._schedule(() => this._expired(created.id), Math.max(0, Date.parse(created.expiresAt) - Date.now())));
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.creatingPairingCode = false;
      this.notify();
    }
  }

  dismissPairingCode() {
    if (!this.pairing) return;
    this._setPairingTimer(null);
    this.pairing = null;
    this.notify();
  }

  async revoke(nodeId: string): Promise<NodesStoreResult> {
    try {
      this._upsert(await api.nodes.revoke(nodeId));
      this.notify();
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }

  /** Deletes the paired node for good. Refused while it holds project sources. */
  async remove(nodeId: string): Promise<NodesStoreResult> {
    try {
      await api.nodes.remove(nodeId);
      this._drop(nodeId);
      this.notify();
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }

  /** The pairing's code was redeemed (the server's word, even if it looked expired here): shown as paired
   * for a moment, then pairing ends. Waiting for the node's first connection would go here, once a remote
   * node can connect. */
  private _paired(node: NodeView) {
    if (!this.pairing) return;
    this.pairing = { ...this.pairing, status: "paired", node };
    this._setPairingTimer(this._schedule(() => this.dismissPairingCode(), PAIRED_DISPLAY_MS));
  }

  private _expired(pairingCodeId: number) {
    if (this.pairing?.id !== pairingCodeId || this.pairing.status !== "waiting") return;
    this.pairing = { ...this.pairing, status: "expired" };
    this._cancelPairingTimer = null;
    this.notify();
  }

  private _setPairingTimer(cancel: (() => void) | null) {
    this._cancelPairingTimer?.();
    this._cancelPairingTimer = cancel;
  }

  /** Replaces the listed node, or adds it in order. Nothing is listed before the first load. */
  private _upsert(node: NodeView) {
    const nodes = this.nodes.data;
    if (!nodes) return;
    const listed = nodes.some((n) => n.id === node.id);
    this.nodes = this.nodes.asLoaded(listed ? nodes.map((n) => n.id === node.id ? node : n) : [...nodes, node].toSorted(byName));
  }

  private _drop(nodeId: string) {
    const nodes = this.nodes.data;
    if (nodes) this.nodes = this.nodes.asLoaded(nodes.filter((node) => node.id !== nodeId));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
