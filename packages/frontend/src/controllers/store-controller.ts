/**
 * StoreController
 *
 * Generic reactive controller that subscribes to any store implementing
 * the `{ subscribe(fn: () => void): () => void }` pattern and calls
 * `host.requestUpdate()` on each notification.
 *
 * This eliminates the need for manual `@state() _storeVersion` counters
 * or prop-drilled `renderVersion` values — any component that reads from
 * a store can attach a StoreController and automatically re-render when
 * the store notifies.
 *
 * Usage:
 *   private storeCtrl = new StoreController(this);
 *
 *   // When the store prop changes (e.g. in willUpdate):
 *   this.storeCtrl.store = this.myStore;
 *
 *   // Or subscribe to multiple stores:
 *   private diffCtrl = new StoreController(this);
 *   private treeCtrl = new StoreController(this);
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

/** Any object with our standard subscribe/unsubscribe pattern. */
export interface Subscribable {
  subscribe(fn: () => void): () => void;
}

export class StoreController<T extends Subscribable = Subscribable>
  implements ReactiveController
{
  private _host: ReactiveControllerHost;
  private _unsub: (() => void) | null = null;
  private _store: T | null = null;

  constructor(host: ReactiveControllerHost) {
    this._host = host;
    host.addController(this);
  }

  /** The currently subscribed store. Changing this re-subscribes automatically. */
  get store(): T | null {
    return this._store;
  }

  set store(s: T | null) {
    if (s === this._store) return;
    this._unsub?.();
    this._unsub = null;
    this._store = s;
    if (s) {
      this._unsub = s.subscribe(() => this._host.requestUpdate());
    }
  }

  hostConnected() {
    // Re-subscribe if we were disconnected while holding a store ref
    if (this._store && !this._unsub) {
      this._unsub = this._store.subscribe(() => this._host.requestUpdate());
    }
  }

  hostDisconnected() {
    this._unsub?.();
    this._unsub = null;
  }
}
