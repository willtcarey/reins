/**
 * File Tree — lazy-loaded directory tree sidebar for the file browser.
 *
 * Thin wrapper around `<tree-view>` that transforms `FileBrowserStore`
 * data into `TreeNode[]`. Handles lazy directory fetching, compact
 * single-child directory chains (VS Code style), and maps tree-view
 * events back to store operations and `open-in-browser` events.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { FileBrowserStore, DirEntry } from "../models/stores/file-browser-store.js";
import { StoreController } from "../controllers/store-controller.js";
import { openInBrowserEvent } from "./events.js";
import "./tree-view.js";
import type { TreeNode } from "./tree-view.js";

@customElement("file-tree")
export class FileTree extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  private _storeCtrl = new StoreController(this);

  /**
   * Track compacted directory chains so we can expand intermediates
   * when the user clicks a compacted directory row.
   * Maps deepPath → list of intermediate paths.
   */
  private _compactedIntermediates = new Map<string, string[]>();

  override connectedCallback() {
    super.connectedCallback();
    this.store?.fetchDirectory(".");
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._storeCtrl.store = this.store;
      this.store?.fetchDirectory(".");
    }
  }

  // ---- Data transformation --------------------------------------------------

  private _buildPath(parent: string, name: string): string {
    return parent === "." ? name : `${parent}/${name}`;
  }

  /**
   * Compact single-child directory chains.
   * Returns the compacted display label, the deepest directory path,
   * and intermediate paths that need expanding.
   */
  private _compactChain(
    entry: DirEntry,
    parentPath: string,
  ): { label: string; deepPath: string; intermediates: string[] } {
    const store = this.store;
    let label = entry.name;
    let currentPath = this._buildPath(parentPath, entry.name);
    const intermediates: string[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const children = store?.directoryEntries.get(currentPath);
      if (!children || children.length !== 1) break;
      const only = children[0]!;
      if (only.type !== "directory") break;

      intermediates.push(currentPath);
      label = `${label}/${only.name}`;
      currentPath = this._buildPath(currentPath, only.name);
    }

    return { label, deepPath: currentPath, intermediates };
  }

  /** Convert store's DirEntry[] into TreeNode[] for tree-view. */
  private _buildNodes(entries: DirEntry[], parentPath: string): TreeNode[] {
    this._compactedIntermediates.clear();
    return this._buildNodesInner(entries, parentPath);
  }

  private _buildNodesInner(entries: DirEntry[], parentPath: string): TreeNode[] {
    return entries.map((entry) => {
      if (entry.type === "file") {
        const path = this._buildPath(parentPath, entry.name);
        return { name: entry.name, path, type: "file" as const };
      }

      const { label, deepPath, intermediates } = this._compactChain(entry, parentPath);

      // Stash intermediates for expand handling
      if (intermediates.length > 0) {
        this._compactedIntermediates.set(deepPath, intermediates);
      }

      const expanded = this.store?.expandedDirs.has(deepPath) ?? false;
      const loading = (this.store?.treeLoading.has(deepPath) ?? false) ||
        intermediates.some((p) => this.store?.treeLoading.has(p));
      const childEntries = this.store?.directoryEntries.get(deepPath);

      return {
        name: label,
        path: deepPath,
        type: "directory" as const,
        expanded,
        loading,
        children: expanded && childEntries
          ? this._buildNodesInner(childEntries, deepPath)
          : undefined,
      };
    });
  }

  // ---- Event handlers -------------------------------------------------------

  private _handleFileClick(e: CustomEvent<string>) {
    this.dispatchEvent(openInBrowserEvent(e.detail));
  }

  private _handleDirToggle(e: CustomEvent<string>) {
    const store = this.store;
    if (!store) return;

    const dirPath = e.detail;
    const isExpanded = store.expandedDirs.has(dirPath);
    const intermediates = this._compactedIntermediates.get(dirPath) ?? [];

    if (isExpanded) {
      store.toggleDirectory(dirPath);
    } else {
      // Expanding — ensure all intermediates in the compacted chain are expanded
      for (const p of intermediates) {
        if (!store.expandedDirs.has(p)) {
          store.toggleDirectory(p);
        }
      }
      store.toggleDirectory(dirPath);
    }
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const rootEntries = store.directoryEntries.get(".");
    const rootLoading = store.treeLoading.has(".");

    if (rootLoading && !rootEntries) {
      return html`<div class="px-4 py-2 text-xs text-zinc-500">Loading…</div>`;
    }

    const nodes = rootEntries ? this._buildNodes(rootEntries, ".") : [];

    return html`
      <tree-view
        .nodes=${nodes}
        .activeFile=${store.selectedFile}
        @tree-file-click=${this._handleFileClick}
        @tree-dir-toggle=${this._handleDirToggle}
      ></tree-view>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-tree": FileTree;
  }
}
