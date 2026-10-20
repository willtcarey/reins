/**
 * Renderers for views, looked up by a view's `view` name. Built-in views use this lookup the way
 * plugin views will; how plugins add renderers is not decided yet, so it stays internal.
 */

import { html, type TemplateResult } from "lit";
import type { FileTreeState } from "../../models/changes/file-tree-state.js";
import type { InspectorTab, ViewName, ViewOf } from "../../models/inspector.js";
import type { WorkspaceStore } from "../../models/stores/workspace-store.js";
import { diffIcon, fileIcon } from "../../ui/icons.js";
import "../changes/diff-file-tree.js";
import "./inspector-file-view.js";

/** What a container gives the views it renders. */
export interface ViewContext {
  store: WorkspaceStore;
  changesTreeState: FileTreeState;
  activeDiffFile: string | null;
}

interface ViewRenderer<V> {
  /** A short name for the view's tab. */
  title(view: V): string;
  /** The whole name, where the title leaves some out. */
  description(view: V): string;
  icon(view: V): TemplateResult;
  render(view: V, tab: InspectorTab, context: ViewContext): TemplateResult;
}

const renderers: { [K in ViewName]: ViewRenderer<ViewOf<K>> } = {
  changes: {
    title: () => "Changes",
    description: () => "Changed files",
    icon: () => diffIcon("shrink-0"),
    render: (_view, _tab, { store, changesTreeState, activeDiffFile }) => html`
      <diff-file-tree
        class="block h-full min-h-0 flex-1"
        data-swipe-surface
        .store=${store.diffStore}
        .reviewStore=${store.codeReviewStore}
        .treeState=${changesTreeState}
        .activeFile=${activeDiffFile}
      ></diff-file-tree>
    `,
  },
  file: {
    title: (view) => view.path.slice(view.path.lastIndexOf("/") + 1),
    description: (view) => view.path,
    icon: () => fileIcon("shrink-0"),
    render: (view, tab, { store }) => html`
      <inspector-file-view
        class="flex h-full min-h-0 flex-col"
        .store=${store.fileModel}
        .path=${view.path}
        .startLine=${view.startLine ?? null}
        .endLine=${view.endLine ?? null}
        .revision=${tab.revision}
      ></inspector-file-view>
    `,
  },
};

function rendererFor<K extends ViewName>(view: ViewOf<K>): ViewRenderer<ViewOf<K>> {
  return renderers[view.view];
}

export function viewTitle<K extends ViewName>(view: ViewOf<K>): string {
  return rendererFor(view).title(view);
}

export function viewDescription<K extends ViewName>(view: ViewOf<K>): string {
  return rendererFor(view).description(view);
}

export function viewIcon<K extends ViewName>(view: ViewOf<K>): TemplateResult {
  return rendererFor(view).icon(view);
}

export function renderView<K extends ViewName>(view: ViewOf<K>, tab: InspectorTab, context: ViewContext): TemplateResult {
  return rendererFor(view).render(view, tab, context);
}
