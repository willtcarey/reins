/** The Inspector's tabs (docs/plans/workspace-inspector.md). */

import type { Disposer, View } from "@reins/sdk";
import type { ViewRegistry } from "../sdk-host/view-registry.js";

export interface InspectorTab {
  readonly key: string;
  /** Replaced by every open that reaches the tab, so a new object means the view was opened again. */
  readonly view: View;
  /** Held open by code (`Inspector.pin`), before the other tabs; the user cannot close it. */
  readonly pinned: boolean;
}

/** The app's Inspector tabs, on `AppStore`; none at first, when the workspace does not show the Inspector. */
export class Inspector {
  private _tabs: readonly InspectorTab[] = [];
  private _activeKey: string | null = null;
  /** How many pins hold each pinned tab. */
  private pins = new Map<string, number>();
  /**
   * The pinned tab whose last release took the focus from it. Changing session releases the old session's pin before
   * the new session pins the same view, and the user, who never left that tab, should not land on its neighbour.
   */
  private releasedFocus: string | null = null;
  private listeners = new Set<() => void>();
  private openListeners = new Set<(view: View) => void>();

  /** `views` says which views are the same view, so an open focuses its tab rather than adding one. */
  constructor(private readonly views: Pick<ViewRegistry, "keyOf">) {}

  get tabs(): readonly InspectorTab[] { return this._tabs; }

  get activeTab(): InspectorTab | null {
    return this._tabs.find((tab) => tab.key === this._activeKey) ?? null;
  }

  open(view: View): void {
    const key = this.views.keyOf(view);
    if (this._tabs.some((tab) => tab.key === key)) {
      this._tabs = this._tabs.map((tab) => (tab.key === key ? { ...tab, view } : tab));
    } else {
      this._tabs = [...this._tabs, { key, view, pinned: false }];
    }
    this._activeKey = key;
    this.releasedFocus = null;
    this.notify();
    for (const listener of this.openListeners) listener(view);
  }

  /**
   * Keeps `view`'s tab open, after the tabs pinned before it, until every pin of it is released. It is not an open: the
   * tab is focused only when there was none, so a view that pins its companion as it mounts takes nothing from the user.
   */
  pin(view: View): Disposer {
    const key = this.views.keyOf(view);
    const held = this.pins.get(key) ?? 0;
    this.pins.set(key, held + 1);
    if (held === 0) {
      const pinned = this._tabs.filter((tab) => tab.pinned);
      const others = this._tabs.filter((tab) => !tab.pinned && tab.key !== key);
      this._tabs = [...pinned, { key, view, pinned: true }, ...others];
      if (this._activeKey == null || this.releasedFocus === key) this._activeKey = key;
      this.releasedFocus = null;
      this.notify();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.pins.get(key) ?? 1) - 1;
      if (left > 0) {
        this.pins.set(key, left);
        return;
      }
      this.pins.delete(key);
      const focused = key === this._activeKey;
      this.remove(key);
      if (focused) this.releasedFocus = key;
    };
  }

  focus(key: string): void {
    if (!this._tabs.some((tab) => tab.key === key)) return;
    this.releasedFocus = null;
    if (key === this._activeKey) return;
    this._activeKey = key;
    this.notify();
  }

  /** The user's close: pinned tabs stay. */
  close(key: string): void {
    if (this._tabs.find((tab) => tab.key === key)?.pinned === false) this.remove(key);
  }

  /** Closes `view`'s tab as the user would (`workspace.close`). */
  closeView(view: View): void {
    this.close(this.views.keyOf(view));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listens for views opened, which a phone moves to the Inspector's page for. */
  onOpen(listener: (view: View) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /** Closes a tab; the active one gives focus to the tab before it, or after it when it was first. */
  private remove(key: string): void {
    const index = this._tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    if (key === this._activeKey) this._activeKey = (this._tabs[index - 1] ?? this._tabs[index + 1])?.key ?? null;
    this._tabs = this._tabs.filter((tab) => tab.key !== key);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
