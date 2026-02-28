/**
 * Multi-Project Store
 *
 * Manages ProjectDataStore instances lazily — one per project, created on
 * demand. Used by the multi-project sidebar to hold list-level data for
 * all expanded projects simultaneously.
 *
 * Components subscribe via `subscribe()` to get notified when any child
 * store changes (notifications bubble up).
 */

import { ProjectDataStore } from "./project-data-store.js";

export type MultiProjectStoreListener = () => void;

export class MultiProjectStore {
  // ---- Private state --------------------------------------------------------

  private _stores = new Map<number, ProjectDataStore>();
  private _unsubscribes = new Map<number, () => void>();
  private _listeners = new Set<MultiProjectStoreListener>();

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: MultiProjectStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Public API -----------------------------------------------------------

  /**
   * Get or create a ProjectDataStore for a project.
   * Creating does NOT fetch — call ensureLoaded() to trigger a fetch.
   */
  getStore(projectId: number): ProjectDataStore {
    let child = this._stores.get(projectId);
    if (child) return child;

    child = new ProjectDataStore(projectId);
    const unsub = child.subscribe(() => this.notify());
    this._stores.set(projectId, child);
    this._unsubscribes.set(projectId, unsub);
    return child;
  }

  /**
   * Get a store only if it already exists (no creation).
   */
  peekStore(projectId: number): ProjectDataStore | undefined {
    return this._stores.get(projectId);
  }

  /**
   * Ensure a project's data is loaded. Creates the store if needed,
   * then fetches if not yet loaded and not currently loading.
   */
  async ensureLoaded(projectId: number): Promise<void> {
    const child = this.getStore(projectId);
    if (!child.loaded && !child.loading) {
      await child.fetchLists();
    }
  }

  /**
   * Refresh a specific project's data. Re-fetches if the store exists,
   * no-op if it doesn't.
   */
  async refresh(projectId: number): Promise<void> {
    const child = this.peekStore(projectId);
    if (child) {
      await child.fetchLists();
    }
  }

  /**
   * Drop a store (e.g. project deleted). Unsubscribes from child
   * notifications and removes from the map.
   */
  remove(projectId: number): void {
    const unsub = this._unsubscribes.get(projectId);
    if (!unsub) return;

    unsub();
    this._unsubscribes.delete(projectId);
    this._stores.delete(projectId);
    this.notify();
  }
}
