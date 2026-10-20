/** Views and the Inspector's tabs (docs/plans/workspace-inspector.md). */

interface ViewParameters {
  changes: Record<never, never>;
  file: { path: string; startLine?: number; endLine?: number };
}

export type ViewName = keyof ViewParameters;
export type ViewOf<K extends ViewName> = { view: K } & ViewParameters[K];
/** What a container shows: a plain, serializable object whose `view` selects its renderer. */
export type View = { [K in ViewName]: ViewOf<K> }[ViewName];

/** The container `open` shows a view in, named by ID so later layouts can add containers. */
export type ContainerId = "inspector";

export interface OpenOptions {
  in?: ContainerId;
}

/** Views with the same key are the same view: a file's lines only move within it. */
export function viewKey(view: View): string {
  return view.view === "file" ? `file:${view.path}` : view.view;
}

export interface InspectorTab {
  readonly key: string;
  readonly view: View;
  /** Bumped by every open that reaches the tab, so the same lines can be revealed twice. */
  readonly revision: number;
  readonly closable: boolean;
}

const CHANGES: InspectorTab = { key: viewKey({ view: "changes" }), view: { view: "changes" }, revision: 0, closable: false };

/** One project's Inspector tabs: the changes tab first and always open. */
export class Inspector {
  private _tabs: readonly InspectorTab[] = [CHANGES];
  private _activeKey = CHANGES.key;
  private _revision = 0;

  get tabs(): readonly InspectorTab[] { return this._tabs; }

  get activeTab(): InspectorTab {
    return this._tabs.find((tab) => tab.key === this._activeKey) ?? CHANGES;
  }

  open(view: View): void {
    const key = viewKey(view);
    const revision = ++this._revision;
    const existing = this._tabs.find((tab) => tab.key === key);
    if (!existing) {
      this._tabs = [...this._tabs, { key, view, revision, closable: true }];
    } else {
      const applied = view.view === "file" && view.startLine == null ? existing.view : view;
      this._tabs = this._tabs.map((tab) => (tab === existing ? { ...tab, view: applied, revision } : tab));
    }
    this._activeKey = key;
  }

  focus(key: string): void {
    if (this._tabs.some((tab) => tab.key === key)) this._activeKey = key;
  }

  close(key: string): void {
    const index = this._tabs.findIndex((tab) => tab.key === key);
    if (index < 0 || !this._tabs[index]!.closable) return;
    if (key === this._activeKey) this._activeKey = this._tabs[index - 1]!.key;
    this._tabs = this._tabs.filter((tab) => tab.key !== key);
  }
}
