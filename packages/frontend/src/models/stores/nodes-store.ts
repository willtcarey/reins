/**
 * Nodes Store
 *
 * Owns the settings page's node list, kept current from node messages
 * (`node_updated`, `node_removed`), the pairing code just created for a new
 * node and how its pairing is going, renaming and removal (revocation stays
 * in the API, for the planned node detail pages). The
 * code is held only until dismissed: the server keeps its hash, so it can
 * never be fetched again.
 */

import type { NodeView } from "@backend/models/node.js";
import { api } from "../api.js";
import { Loadable } from "../../helpers/loadable.js";
import type { InboundEventSource } from "../ws-client.js";

export type NodesStoreResult = { ok: true } | { error: string };
export type NodeStatus = "connected" | "offline" | "revoked";

/** Runs `fn` after `ms`; returns a function that cancels it. Tests inject their own. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** How long a newly paired node is shown connected before the node list returns. */
export const PAIRED_DISPLAY_MS = 1500;

export interface PairingCode {
  id: number;
  code: string;
  expiresAt: string;
}

/**
 * A pairing code and how its pairing is going: `waiting` for a machine to redeem it, `paired` once one
 * did (as `node`) and waiting, without a timeout, for that node's first connection, `connected` once it
 * connected (shown for `PAIRED_DISPLAY_MS`, then pairing ends), or `expired` unredeemed. Pairing also ends
 * when its node is removed. `name` is the name it was created with ("" for the node's hostname).
 */
export type Pairing = PairingCode & { name: string } & (
  | { status: "waiting" }
  | { status: "paired"; node: NodeView }
  | { status: "connected"; node: NodeView }
  | { status: "expired" }
);

/** Whether the node can connect: a revoked node is refused whatever its link. */
export function nodeStatus(node: NodeView): NodeStatus {
  if (node.revokedAt) return "revoked";
  return node.connected ? "connected" : "offline";
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
  /** The node whose rename is being saved. */
  renamingNodeId: string | null = null;

  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;
  /** Cancels the pairing's pending timer: its expiry while waiting, its end once connected. */
  private _cancelPairingTimer: (() => void) | null = null;

  constructor(eventSource?: InboundEventSource, private _schedule: Schedule = defaultSchedule) {
    this._unsubscribe = eventSource?.subscribe({
      node_updated: (message) => {
        this._upsert(message.node);
        this._pairingProgress(message.node, message.pairingCodeId);
        this.notify();
      },
      node_removed: (message) => {
        this._drop(message.nodeId);
        // The node it paired is gone: there is nothing left to wait for.
        if (this.pairing && "node" in this.pairing && this.pairing.node.id === message.nodeId) {
          this._setPairingTimer(null);
          this.pairing = null;
        }
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

  /** Removes the paired node for good: it is refused from then on, and no longer listed. Sessions on its
   * sources stay, to be moved to another node. */
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

  /** Renames the node to `name` trimmed (any node, the local one included). */
  async rename(nodeId: string, name: string): Promise<NodesStoreResult> {
    this.renamingNodeId = nodeId;
    this.notify();

    try {
      this._upsert(await api.nodes.rename(nodeId, { name: name.trim() }));
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.renamingNodeId = null;
      this.notify();
    }
  }

  /** A node update for the pairing: its code redeemed (the server's word, even if it looked expired here),
   * or its paired node changed. Paired, it waits for the node to connect (it may already have); connected,
   * it is shown for a moment, then pairing ends. */
  private _pairingProgress(node: NodeView, pairingCodeId: number | undefined) {
    const pairing = this.pairing;
    if (!pairing) return;
    const redeemed = pairingCodeId === pairing.id && (pairing.status === "waiting" || pairing.status === "expired");
    const pairedNode = pairing.status === "paired" && pairing.node.id === node.id;
    if (!redeemed && !pairedNode) return;
    if (node.connected) {
      this.pairing = { ...pairing, status: "connected", node };
      this._setPairingTimer(this._schedule(() => this.dismissPairingCode(), PAIRED_DISPLAY_MS));
    } else {
      this.pairing = { ...pairing, status: "paired", node };
      this._setPairingTimer(null);
    }
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

  /** Replaces the listed node, or adds it, in order (a renamed node moves). Nothing is listed before the
   * first load. */
  private _upsert(node: NodeView) {
    const nodes = this.nodes.data;
    if (!nodes) return;
    this.nodes = this.nodes.asLoaded([...nodes.filter((n) => n.id !== node.id), node].toSorted(byName));
  }

  private _drop(nodeId: string) {
    const nodes = this.nodes.data;
    if (nodes) this.nodes = this.nodes.asLoaded(nodes.filter((node) => node.id !== nodeId));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
