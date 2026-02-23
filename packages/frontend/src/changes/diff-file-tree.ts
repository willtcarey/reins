/**
 * Diff File Tree
 *
 * Lit web component that renders a nested file tree of changed files from a
 * git diff. Directories are collapsible and show aggregate +/− stats.
 * Clicking a file emits a `file-select` CustomEvent with the file path.
 * Uses light DOM for Tailwind compatibility.
 *
 * Receives its data from a shared DiffStore instance.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import type { DiffFileSummary } from "./types.js";
import type { DiffStore } from "../stores/diff-store.js";
import type { DiffMode } from "../stores/diff-store.js";
import type { FileTreeState } from "./file-tree-state.js";

interface TreeNode {
  name: string;
  /** Full path from repo root (for files) or directory prefix (for dirs) */
  path: string;
  additions: number;
  removals: number;
  children: TreeNode[];
  isFile: boolean;
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Build a nested tree structure from a flat list of file paths.
 * Directories are sorted before files; each group is sorted alphabetically.
 */
function buildTree(files: DiffFileSummary[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    additions: 0,
    removals: 0,
    children: [],
    isFile: false,
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join("/");

      let child = current.children.find(
        (c) => c.name === part && c.isFile === isLast
      );

      if (!child) {
        child = {
          name: part,
          path: partPath,
          additions: 0,
          removals: 0,
          children: [],
          isFile: isLast,
        };
        current.children.push(child);
      }

      // Accumulate stats up the tree
      child.additions += file.additions;
      child.removals += file.removals;

      current = child;
    }
  }

  // Sort: directories first, then files, each group alphabetical
  function sortChildren(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
      if (!child.isFile) sortChildren(child);
    }
  }
  sortChildren(root);

  return root.children;
}

// ---- Component -------------------------------------------------------------

@customElement("diff-file-tree")
export class DiffFileTree extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Shared diff data store. */
  @property({ attribute: false })
  store: DiffStore | null = null;

  /** Currently highlighted / visible file path. */
  @property({ type: String })
  activeFile: string | null = null;

  /** Shared UI state for collapse/expand. */
  @property({ attribute: false })
  treeState: FileTreeState | null = null;

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
    this._unsubscribe = null;
    this._unsubscribeTree?.();
    this._unsubscribeTree = null;
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

  private get collapsedDirs(): Set<string> {
    return this.treeState?.collapsedDirs ?? new Set();
  }

  private toggleDir(path: string) {
    this.treeState?.toggleDir(path);
  }

  private handleModeChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const mode = select.value as DiffMode;
    this.store?.setDiffMode(mode);
  }

  private selectFile(path: string) {
    this.dispatchEvent(
      new CustomEvent("file-select", {
        detail: path,
        bubbles: true,
        composed: true,
      })
    );
  }

  private renderStats(additions: number, removals: number) {
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
  }

  private renderIndentGuides(depth: number) {
    if (depth === 0) return nothing;
    const guides = [];
    for (let i = 0; i < depth; i++) {
      const styles = {
        position: "absolute",
        left: `${i * 12 + 16}px`,
        top: "0",
        bottom: "0",
        width: "1px",
        background: "var(--color-zinc-700)",
        opacity: "0.4",
      };
      guides.push(html`<span style=${styleMap(styles)}></span>`);
    }
    return guides;
  }

  private renderNode(node: TreeNode, depth: number): unknown {
    const indent = depth * 12;

    if (node.isFile) {
      const isActive = this.activeFile === node.path;
      return html`
        <button
          class="relative w-full flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer transition-colors truncate
            ${isActive
              ? "bg-blue-500/15 text-blue-300"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"}"
          style="padding-left: ${indent + 8}px"
          @click=${() => this.selectFile(node.path)}
          title=${node.path}
        >
          ${this.renderIndentGuides(depth)}
          <svg class="w-3.5 h-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <span class="truncate">${node.name}</span>
          ${this.renderStats(node.additions, node.removals)}
        </button>
      `;
    }

    // Directory node
    const collapsed = this.collapsedDirs.has(node.path);
    return html`
      <div>
        <button
          class="relative w-full flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer transition-colors text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/50 truncate"
          style="padding-left: ${indent + 8}px"
          @click=${() => this.toggleDir(node.path)}
        >
          ${this.renderIndentGuides(depth)}
          <span class="text-[10px] text-zinc-500 shrink-0 w-3 text-center">${collapsed ? "▶" : "▼"}</span>
          <svg class="w-3.5 h-3.5 shrink-0 ${collapsed ? "text-zinc-500" : "text-zinc-400"}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
          <span class="truncate">${node.name}</span>
        </button>
        ${!collapsed
          ? node.children.map((child) => this.renderNode(child, depth + 1))
          : nothing}
      </div>
    `;
  }

  private renderModeSelector() {
    const currentMode = this.store?.diffMode ?? "branch";
    const baseBranch = this.store?.data.baseBranch;

    return html`
      <div class="px-3 py-2 border-b border-zinc-700 shrink-0">
        <select
          class="w-full bg-zinc-800 text-zinc-300 text-xs rounded border border-zinc-600 px-2 py-1.5 cursor-pointer focus:outline-none focus:border-zinc-500 appearance-none"
          style="background-image: url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E&quot;); background-repeat: no-repeat; background-position: right 6px center;"
          .value=${currentMode}
          @change=${this.handleModeChange}
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
          ${this.renderModeSelector()}
          <div class="flex-1 flex items-center justify-center text-zinc-500 text-xs p-4">
            No changes
          </div>
        </div>
      `;
    }

    const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
    const totalRemovals = files.reduce((s, f) => s + f.removals, 0);
    const tree = buildTree(files);

    return html`
      <div class="h-full flex flex-col min-w-0">
        ${this.renderModeSelector()}
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
        <div class="flex-1 overflow-y-auto py-1">
          ${tree.map((node) => this.renderNode(node, 0))}
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
