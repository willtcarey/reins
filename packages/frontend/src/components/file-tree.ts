/**
 * File Tree — lazy-loaded directory tree sidebar for the file browser.
 *
 * Thin wrapper around `<tree-view>` that transforms `FileBrowserStore`
 * data into `TreeNode[]`. Handles lazy directory fetching and maps
 * tree-view events back to store operations and `open-in-browser` events.
 *
 * Single-child directory compaction (VS Code style) is handled by
 * `<tree-view>` automatically.
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

  /** Convert store's DirEntry[] into TreeNode[] for tree-view. */
  private _buildNodes(entries: DirEntry[], parentPath: string): TreeNode[] {
    return entries.map((entry) => {
      const path = this._buildPath(parentPath, entry.name);

      if (entry.type === "file") {
        return { name: entry.name, path, type: "file" as const };
      }

      const expanded = this.store?.expandedDirs.has(path) ?? false;
      const loading = this.store?.treeLoading.has(path) ?? false;
      const childEntries = this.store?.directoryEntries.get(path);

      return {
        name: entry.name,
        path,
        type: "directory" as const,
        expanded,
        loading,
        children: expanded && childEntries
          ? this._buildNodes(childEntries, path)
          : undefined,
      };
    });
  }

  // ---- Event handlers -------------------------------------------------------

  private _handleFileClick(e: CustomEvent<string>) {
    this.dispatchEvent(openInBrowserEvent(e.detail));
  }

  /**
   * Handle directory toggle from tree-view.
   *
   * tree-view may compact single-child chains and emit the deepest
   * directory path. When expanding, we also need to expand any
   * intermediate ancestors that aren't already expanded (they may
   * have been collapsed as part of a previous collapse).
   */
  private _handleDirToggle(e: CustomEvent<string>) {
    const store = this.store;
    if (!store) return;

    const dirPath = e.detail;
    const isExpanded = store.expandedDirs.has(dirPath);

    if (isExpanded) {
      store.toggleDirectory(dirPath);
    } else {
      // Ensure all ancestor directories are expanded (handles compacted chains)
      const parts = dirPath.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (!store.expandedDirs.has(ancestor)) {
          store.toggleDirectory(ancestor);
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
