/**
 * File Tree — recursive directory tree sidebar for the file browser.
 *
 * Renders a lazy-loaded directory tree from the store's `directoryEntries`.
 * Directories expand/collapse on click; files dispatch `open-in-browser`
 * events that bubble up to the app shell.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FileBrowserStore, DirEntry } from "../models/stores/file-browser-store.js";
import { openInBrowserEvent } from "./events.js";

@customElement("file-tree")
export class FileTree extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _storeVersion = 0;

  private _unsub: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribeToStore();
    this.store?.fetchDirectory(".");
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._subscribeToStore();
      this.store?.fetchDirectory(".");
    }
  }

  private _subscribeToStore() {
    this._unsub?.();
    if (!this.store) return;
    this._unsub = this.store.subscribe(() => {
      this._storeVersion++;
    });
  }

  private _buildPath(parent: string, name: string): string {
    return parent === "." ? name : `${parent}/${name}`;
  }

  private _handleDirClick(path: string) {
    this.store?.toggleDirectory(path);
  }

  private _handleFileClick(path: string) {
    this.dispatchEvent(openInBrowserEvent(path));
  }

  private _renderEntry(entry: DirEntry, parentPath: string, depth: number): unknown {
    const fullPath = this._buildPath(parentPath, entry.name);
    const indent = depth * 16;

    if (entry.type === "directory") {
      return this._renderDirectory(entry.name, fullPath, depth, indent);
    }

    const isSelected = this.store?.selectedFile === fullPath;
    return html`
      <button
        class="w-full flex items-center gap-1.5 px-2 py-0.5 text-left text-sm font-mono truncate cursor-pointer
               hover:bg-zinc-700/50 ${isSelected ? "bg-zinc-700 text-zinc-100" : "text-zinc-300"}"
        style="padding-left: ${indent + 8}px"
        @click=${() => this._handleFileClick(fullPath)}
        title=${fullPath}
      >
        <span class="w-4 shrink-0"></span>
        <span class="truncate">${entry.name}</span>
      </button>
    `;
  }

  private _renderDirectory(name: string, fullPath: string, depth: number, indent: number): unknown {
    const expanded = this.store?.expandedDirs.has(fullPath);
    const loading = this.store?.treeLoading.has(fullPath);
    const children = this.store?.directoryEntries.get(fullPath);

    return html`
      <div>
        <button
          class="w-full flex items-center gap-1.5 px-2 py-0.5 text-left text-sm font-mono font-medium truncate cursor-pointer
                 hover:bg-zinc-700/50 text-zinc-200"
          style="padding-left: ${indent + 8}px"
          @click=${() => this._handleDirClick(fullPath)}
          title=${fullPath}
        >
          <span class="w-4 shrink-0 text-zinc-500 text-xs text-center">${expanded ? "▼" : "▶"}</span>
          <span class="truncate">${name}</span>
          ${loading ? html`<span class="text-zinc-500 text-xs ml-1">…</span>` : nothing}
        </button>
        ${expanded && children
          ? children.map((child) => this._renderEntry(child, fullPath, depth + 1))
          : nothing}
      </div>
    `;
  }

  override render() {
    void this._storeVersion;
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
