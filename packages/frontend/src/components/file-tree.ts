/**
 * File Tree — recursive directory tree sidebar for the file browser.
 *
 * Renders a lazy-loaded directory tree from the store's `directoryEntries`.
 * Directories expand/collapse on click; files dispatch `open-in-browser`
 * events that bubble up to the app shell.
 *
 * Features:
 * - SVG file/folder icons instead of disclosure triangles
 * - Compact single-child directory chains (VS Code style): `src/components/ui`
 *   renders as one row when each intermediate dir has exactly one child dir.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { FileBrowserStore, DirEntry } from "../models/stores/file-browser-store.js";
import { StoreController } from "../controllers/store-controller.js";
import { openInBrowserEvent } from "./events.js";
import { svg } from "lit";

// ---- SVG icons (14×14, stroke-based) ----------------------------------------

/** Closed folder: rectangle with a tab on top-left */
const folderIcon = svg`<svg class="shrink-0 text-zinc-500" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 3.5h3.5l1 1H12a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/>
</svg>`;

/** Open folder: top edge angled open */
const folderOpenIcon = svg`<svg class="shrink-0 text-zinc-500" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 11V4.5a1 1 0 0 1 1-1h3.5l1 1H12a1 1 0 0 1 1 1V7"/>
  <path d="M1 11l1.5-4h10l-1.5 4H1Z"/>
</svg>`;

/** File: rectangle with dog-ear corner */
const fileIcon = svg`<svg class="shrink-0 text-zinc-500" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 1H3.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5L8 1Z"/>
  <path d="M8 1v3.5h3.5"/>
</svg>`;

/** Indentation per nesting level (px) */
const INDENT_PX = 12;

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

  private _buildPath(parent: string, name: string): string {
    return parent === "." ? name : `${parent}/${name}`;
  }

  private _handleFileClick(path: string) {
    this.dispatchEvent(openInBrowserEvent(path));
  }

  /**
   * Handle click on a (possibly compacted) directory row.
   * Toggles the deepest directory, while ensuring all intermediate
   * directories in the compacted chain are expanded so their entries
   * get fetched.
   */
  private _handleCompactedDirClick(fullPath: string, intermediatePaths: string[]) {
    const store = this.store;
    if (!store) return;

    const isExpanded = store.expandedDirs.has(fullPath);

    if (isExpanded) {
      // Collapsing — just collapse the deepest
      store.toggleDirectory(fullPath);
    } else {
      // Expanding — ensure all intermediates are expanded too
      for (const p of intermediatePaths) {
        if (!store.expandedDirs.has(p)) {
          store.toggleDirectory(p);
        }
      }
      store.toggleDirectory(fullPath);
    }
  }

  /**
   * Try to compact a chain of single-child directories starting from
   * the given entry. Returns the compacted display label, the deepest
   * directory path, and intermediate paths that need expanding.
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

      // This directory has a single child that is also a directory — compact
      intermediates.push(currentPath);
      label = `${label}/${only.name}`;
      currentPath = this._buildPath(currentPath, only.name);
    }

    return { label, deepPath: currentPath, intermediates };
  }

  private _renderEntry(entry: DirEntry, parentPath: string, depth: number): unknown {
    if (entry.type === "directory") {
      return this._renderDirectoryEntry(entry, parentPath, depth);
    }

    const fullPath = this._buildPath(parentPath, entry.name);
    const indent = depth * INDENT_PX;
    const isSelected = this.store?.selectedFile === fullPath;
    return html`
      <button
        class="w-full flex items-center gap-1.5 px-2 py-0.5 text-left text-sm font-mono truncate cursor-pointer
               hover:bg-zinc-700/50 ${isSelected ? "bg-zinc-700 text-zinc-100" : "text-zinc-300"}"
        style="padding-left: ${indent + 8}px"
        @click=${() => this._handleFileClick(fullPath)}
        title=${fullPath}
      >
        ${fileIcon}
        <span class="truncate">${entry.name}</span>
      </button>
    `;
  }

  /**
   * Render a directory entry, compacting single-child chains.
   */
  private _renderDirectoryEntry(
    entry: DirEntry,
    parentPath: string,
    depth: number,
  ): TemplateResult {
    const { label, deepPath, intermediates } = this._compactChain(entry, parentPath);
    const indent = depth * INDENT_PX;
    const expanded = this.store?.expandedDirs.has(deepPath);
    const loading = this.store?.treeLoading.has(deepPath) ||
      intermediates.some((p) => this.store?.treeLoading.has(p));
    const children = this.store?.directoryEntries.get(deepPath);

    return html`
      <div>
        <button
          class="w-full flex items-center gap-1.5 px-2 py-0.5 text-left text-sm font-mono font-medium truncate cursor-pointer
                 hover:bg-zinc-700/50 text-zinc-200"
          style="padding-left: ${indent + 8}px"
          @click=${() => this._handleCompactedDirClick(deepPath, intermediates)}
          title=${deepPath}
        >
          ${expanded ? folderOpenIcon : folderIcon}
          <span class="truncate">${label}</span>
          ${loading ? html`<span class="text-zinc-500 text-xs ml-1">…</span>` : nothing}
        </button>
        ${expanded && children
          ? children.map((child) => this._renderEntry(child, deepPath, depth + 1))
          : nothing}
      </div>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const rootEntries = store.directoryEntries.get(".");
    const rootLoading = store.treeLoading.has(".");

    return html`
      <div class="overflow-y-auto min-w-0 py-1">
        ${rootLoading && !rootEntries
          ? html`<div class="px-4 py-2 text-xs text-zinc-500">Loading…</div>`
          : rootEntries
            ? rootEntries.map((entry) => this._renderEntry(entry, ".", 0))
            : html`<div class="px-4 py-2 text-xs text-zinc-500">No files</div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-tree": FileTree;
  }
}
