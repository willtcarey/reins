/** The Inspector's tabs (docs/plans/workspace-inspector.md). */

import { viewKey, type View } from "../reins-sdk/contract.js";

export interface InspectorTab {
  readonly key: string;
  /** Replaced by every open that reaches the tab, so a new object means the view was opened again. */
  readonly view: View;
  readonly closable: boolean;
}

const DIFF_FILE_TREE: InspectorTab = { key: viewKey({ view: "diff-file-tree" }), view: { view: "diff-file-tree" }, closable: false };

/** One project's Inspector tabs: the diff file tree (the Changes tab) first and always open. */
export class Inspector {
  private _tabs: readonly InspectorTab[] = [DIFF_FILE_TREE];
  private _activeKey = DIFF_FILE_TREE.key;

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
