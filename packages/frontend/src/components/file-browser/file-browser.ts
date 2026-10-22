/**
 * File Browser — overlay with tree sidebar and file content viewer, shown while its store's
 * `browserOpen`. Renders a header bar, a directory tree sidebar (`<file-tree>`) and the shared
 * `<file-viewer>`. Escape, the backdrop or the close button close it.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import type { FileViewMode } from "reins-sdk/contract";
import { StoreController } from "../../controllers/store-controller.js";
import "../file-viewer/file-viewer.js";
import "./file-tree.js";
import { closeIcon, downloadIcon, fileSearchIcon, menuIcon, panelRightIcon } from "../../ui/icons.js";

@customElement("file-browser")
export class FileBrowser extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: FileBrowserStore | null = null;

  /** Whether the mobile tree slide-out panel is visible. */
  @state() private _mobileTreeOpen = false;

  private _storeCtrl = new StoreController<FileBrowserStore>(this);
  private _wasOpen = false;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onGlobalKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this._onGlobalKeydown);
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("store")) this._storeCtrl.store = this.store;
    const open = this.store?.browserOpen ?? false;
    if (open && !this._wasOpen) this._mobileTreeOpen = false;
    this._wasOpen = open;
  }

  private close() {
    this.store?.close();
  }

  private _openFileSearch() {
    const source = this.store?.source;
    if (source) this.store?.openSearch(source);
  }

  private _onGlobalKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.store?.browserOpen && !this.store.searchOpen) {
      e.preventDefault();
      this.close();
    }
  };

  private _onHtmlPreviewEscape = () => {
    if (this.store?.browserOpen) this.close();
  };

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "file-browser-backdrop") {
      this.close();
    }
  }

  override render() {
    const store = this.store;
    if (!store?.browserOpen) return nothing;
    const path = store.path;
    const downloadUrl = path ? store.contentUrl(path, { download: true }) : null;

    return html`
      <div
        id="file-browser-backdrop"
        class="fixed inset-0 z-[var(--layer-overlay)] flex items-center justify-center bg-black/70 sm:px-4"
        @click=${this.handleBackdropClick}
      >
        <div class="w-[100vw] h-[100dvh] min-w-0 min-h-0 sm:w-[90vw] sm:h-[90vh] overflow-hidden bg-zinc-800 sm:ring-1 sm:ring-zinc-600 sm:rounded-lg shadow-2xl flex flex-col">
          <div class="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 min-w-0">
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 sm:hidden"
              @click=${() => { this._mobileTreeOpen = !this._mobileTreeOpen; }}
              title="Toggle file tree"
            >
              ${menuIcon("", 16)}
            </button>
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 sm:hidden"
              @click=${this._openFileSearch}
              title="Search files"
            >
              ${fileSearchIcon()}
            </button>
            <span class="text-sm text-zinc-300 font-mono truncate flex-1">${path}</span>
            ${path ? html`
              <button
                class="flex items-center gap-1.5 p-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 cursor-pointer shrink-0 transition-colors"
                title="Open in Inspector"
                @click=${() => store.openInInspector()}
              >${panelRightIcon()}<span class="sr-only sm:not-sr-only">Open in Inspector</span></button>
            ` : nothing}
            ${path && downloadUrl ? html`
              <a
                class="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 cursor-pointer shrink-0 transition-colors"
                href=${downloadUrl}
                download=${path.split("/").pop() || path}
                title="Download file"
                aria-label=${`Download ${path}`}
                @click=${(e: Event) => e.stopPropagation()}
              >
                ${downloadIcon()}
              </a>
            ` : nothing}
            <kbd class="hidden sm:inline text-[10px] text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">Esc</kbd>
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
              @click=${() => this.close()}
              title="Close"
            >
              ${closeIcon()}
            </button>
          </div>

          <div class="flex flex-1 min-h-0 overflow-hidden relative">
            <div class="hidden sm:block w-[220px] shrink-0 border-r border-zinc-700 overflow-y-auto">
              <file-tree .store=${store} .activeFile=${path}></file-tree>
            </div>

            ${this._mobileTreeOpen ? html`
              <div
                class="sm:hidden absolute inset-0 z-10 flex"
                @click=${(e: MouseEvent) => {
                  if (e.target instanceof HTMLElement && e.target.id === "mobile-tree-backdrop") {
                    this._mobileTreeOpen = false;
                  }
                }}
              >
                <div class="w-[260px] shrink-0 bg-zinc-800 border-r border-zinc-700 overflow-y-auto shadow-xl"
                     @tree-file-click=${() => { this._mobileTreeOpen = false; }}>
                  <file-tree .store=${store} .activeFile=${path}></file-tree>
                </div>
                <div id="mobile-tree-backdrop" class="flex-1 bg-black/50"></div>
              </div>
            ` : nothing}

            <file-viewer
              class="flex-1 min-w-0 flex flex-col"
              .path=${path ?? ""}
              .file=${path ? store.file.content ?? undefined : undefined}
              .contentUrl=${path ? store.contentUrl(path) : null}
              .initialView=${store.mode}
              .highlightRequest=${store.lines}
              @file-view-mode-change=${(e: CustomEvent<FileViewMode>) => store.setMode(e.detail)}
              @html-preview-escape=${this._onHtmlPreviewEscape}
            ></file-viewer>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-browser": FileBrowser;
  }
}
