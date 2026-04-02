/**
 * Diff File Tree
 *
 * Renders a nested file tree of changed files from a git diff.
 * Thin wrapper around `<tree-view>` — builds `TreeNode[]` from
 * DiffStore file data, provides a `renderNodeTrailer` callback for
 * +/− stats, and maps tree-view events to `file-select` events.
 *
 * Also owns the diff mode selector (branch vs uncommitted).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { DiffFileSummary } from "../../models/changes/types.js";
import type { DiffStore } from "../../models/stores/diff-store.js";
import type { FileTreeState } from "../../models/changes/file-tree-state.js";
import "../tree-view.js";
import type { TreeNode, RenderNodeTrailer } from "../tree-view.js";

// ---- Tree building ----------------------------------------------------------

interface BuildNode {
  name: string;
  path: string;
  additions: number;
  removals: number;
  children: BuildNode[];
  isFile: boolean;
}

/** Sort tree nodes: directories first, then files, each group alphabetical. */
function sortChildren(node: BuildNode) {
  node.children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (!child.isFile) sortChildren(child);
  }
}

/**
 * Build a nested tree structure from a flat list of file paths.
 */
function buildBuildTree(files: DiffFileSummary[]): BuildNode[] {
  const root: BuildNode = {
    name: "", path: "", additions: 0, removals: 0, children: [], isFile: false,
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join("/");

      let child = current.children.find(
        (c) => c.name === part && c.isFile === isLast,
      );

      if (!child) {
        child = {
          name: part, path: partPath, additions: 0, removals: 0,
          children: [], isFile: isLast,
        };
        current.children.push(child);
      }

      child.additions += file.additions;
      child.removals += file.removals;

      current = child;
    }
  }

  sortChildren(root);
  return root.children;
}

/** Stash stats on TreeNode for the renderNodeTrailer callback. */
const statsMap = new Map<string, { additions: number; removals: number }>();

/** Convert BuildNode tree → TreeNode tree, recording stats in the side map. */
function toTreeNodes(buildNodes: BuildNode[], collapsedDirs: Set<string>): TreeNode[] {
  return buildNodes.map((bn) => {
    statsMap.set(bn.path, { additions: bn.additions, removals: bn.removals });

    if (bn.isFile) {
      return { name: bn.name, path: bn.path, type: "file" as const };
    }

    const expanded = !collapsedDirs.has(bn.path);
    return {
      name: bn.name,
      path: bn.path,
      type: "directory" as const,
      expanded,
      children: expanded ? toTreeNodes(bn.children, collapsedDirs) : undefined,
    };
  });
}

// ---- Component --------------------------------------------------------------

@customElement("diff-file-tree")
export class DiffFileTree extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: DiffStore | null = null;
  @property({ type: String }) activeFile: string | null = null;
  @property({ attribute: false }) treeState: FileTreeState | null = null;

  private _unsubscribe: (() => void) | null = null;
  private _unsubscribeTree: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store") || changed.has("treeState")) {
      this._subscribe();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribeTree?.();
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubscribeTree?.();
    this._unsubscribeTree = null;
    if (this.store) {
      this._unsubscribe = this.store.subscribe(() => this.requestUpdate());
    }
    if (this.treeState) {
      this._unsubscribeTree = this.treeState.subscribe(() => this.requestUpdate());
    }
  }

  // ---- Event handlers -------------------------------------------------------

  private _handleFileClick(e: CustomEvent<string>) {
    this.dispatchEvent(
      new CustomEvent("file-select", {
        detail: e.detail, bubbles: true, composed: true,
      }),
    );
  }

  private _handleDirToggle(e: CustomEvent<string>) {
    this.treeState?.toggleDir(e.detail);
  }

  private _handleModeChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    const mode = e.target.value;
    if (mode !== "branch" && mode !== "uncommitted") return;
    this.store?.setDiffMode(mode);
  }

  // ---- Render extras --------------------------------------------------------

  private _renderNodeTrailer: RenderNodeTrailer = (node) => {
    if (node.type !== "file") return nothing;
    const stats = statsMap.get(node.path);
    if (!stats) return nothing;
    const { additions, removals } = stats;
    if (additions === 0 && removals === 0) return nothing;

    return html`
      <span class="ml-auto flex items-center gap-1.5 shrink-0 pl-2">
        ${additions > 0
          ? html`<span class="text-green-400 font-mono text-[10px]">+${additions}</span>`
          : nothing}
        ${removals > 0
          ? html`<span class="text-red-400 font-mono text-[10px]">-${removals}</span>`
          : nothing}
      </span>
    `;
  };

  // ---- Render ---------------------------------------------------------------

  private _renderModeSelector() {
    const currentMode = this.store?.diffMode ?? "branch";
    const baseBranch = this.store?.data.baseBranch;

    return html`
      <div class="px-3 py-2 border-b border-zinc-700 shrink-0">
        <select
          class="w-full bg-zinc-800 text-zinc-300 text-xs rounded border border-zinc-600 px-2 py-1.5 cursor-pointer focus:outline-none focus:border-zinc-500 appearance-none"
          style="background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 6px center;"
          .value=${currentMode}
          @change=${this._handleModeChange}
        >
          <option value="branch">Branch changes${baseBranch ? ` (vs ${baseBranch})` : ""}</option>
          <option value="uncommitted">Uncommitted changes</option>
        </select>
      </div>
    `;
  }

  override render() {
    const files = this.store?.data.files ?? [];

    if (files.length === 0) {
      return html`
        <div class="h-full flex flex-col min-w-0">
          ${this._renderModeSelector()}
          <div class="flex-1 flex items-center justify-center text-zinc-500 text-xs p-4">
            No changes
          </div>
        </div>
      `;
    }

    const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
    const totalRemovals = files.reduce((s, f) => s + f.removals, 0);
    const collapsedDirs = this.treeState?.collapsedDirs ?? new Set<string>();

    // Build tree and convert to TreeNode[]
    const buildTree = buildBuildTree(files);
    statsMap.clear();
    const nodes = toTreeNodes(buildTree, collapsedDirs);

    return html`
      <div class="h-full flex flex-col min-w-0">
        ${this._renderModeSelector()}
        <!-- Summary header -->
        <div class="px-3 py-2 text-xs text-zinc-400 border-b border-zinc-700 flex items-center gap-2 shrink-0">
          <span>${files.length} file${files.length !== 1 ? "s" : ""}</span>
          ${totalAdditions > 0
            ? html`<span class="text-green-400 font-mono">+${totalAdditions}</span>`
            : nothing}
          ${totalRemovals > 0
            ? html`<span class="text-red-400 font-mono">-${totalRemovals}</span>`
            : nothing}
        </div>
        <!-- Tree -->
        <div class="flex-1 overflow-y-auto">
          <tree-view
            .nodes=${nodes}
            .activeFile=${this.activeFile}
            .renderNodeTrailer=${this._renderNodeTrailer}
            @tree-file-click=${this._handleFileClick}
            @tree-dir-toggle=${this._handleDirToggle}
          ></tree-view>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-file-tree": DiffFileTree;
  }
}
