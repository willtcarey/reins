/** The Inspector's tabs (docs/plans/workspace-inspector.md). */

import { sameSource, viewKey, type Source, type View } from "../reins-sdk/contract.js";

export interface InspectorTab {
  readonly key: string;
  /** Replaced by every open that reaches the tab, so a new object means the view was opened again. */
  readonly view: View;
  readonly closable: boolean;
}

const DIFF_FILE_TREE: InspectorTab = { key: viewKey({ view: "diff-file-tree" }), view: { view: "diff-file-tree" }, closable: false };

/** The app's Inspector tabs, on `AppStore`: the diff file tree (the Changes tab) first and always open. */
export class Inspector {
  private _tabs: readonly InspectorTab[] = [DIFF_FILE_TREE];
  private _activeKey = DIFF_FILE_TREE.key;
  private viewedSource: Source | null = null;
  private listeners = new Set<() => void>();
  private openListeners = new Set<(view: View) => void>();

  get tabs(): readonly InspectorTab[] { return this._tabs; }

  get activeTab(): InspectorTab {
    return this._tabs.find((tab) => tab.key === this._activeKey) ?? DIFF_FILE_TREE;
  }

  open(view: View): void {
    const key = viewKey(view);
    if (this._tabs.some((tab) => tab.key === key)) {
      this._tabs = this._tabs.map((tab) => (tab.key === key ? { ...tab, view } : tab));
    } else {
      this._tabs = [...this._tabs, { key, view, closable: true }];
    }
    this._activeKey = key;
    this.notify();
    for (const listener of this.openListeners) listener(view);
  }

  focus(key: string): void {
    if (key === this._activeKey || !this._tabs.some((tab) => tab.key === key)) return;
    this._activeKey = key;
    this.notify();
  }

  close(key: string): void {
    const index = this._tabs.findIndex((tab) => tab.key === key);
    if (index < 0 || !this._tabs[index]!.closable) return;
    if (key === this._activeKey) this._activeKey = this._tabs[index - 1]!.key;
    this._tabs = this._tabs.filter((tab) => tab.key !== key);
    this.notify();
  }

  /**
   * The viewed session's source. When it changes to another source, every closable tab closes. The
   * first source known, and null (a session still loading, no session), close nothing.
   */
  setViewedSource(source: Source | null): void {
    if (!source || sameSource(source, this.viewedSource)) return;
    const previous = this.viewedSource;
    this.viewedSource = source;
    if (!previous || this._tabs.length === 1) return;
    this._tabs = [DIFF_FILE_TREE];
    this._activeKey = DIFF_FILE_TREE.key;
    this.notify();
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

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
