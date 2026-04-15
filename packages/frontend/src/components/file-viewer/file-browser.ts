/**
 * File Browser — overlay with tree sidebar and file content viewer.
 *
 * Opens via `openFile(path)` (called by the app shell in response to
 * `open-in-browser` events). Renders a header bar, a directory tree
 * sidebar (`<file-tree>`), and a content viewer (`<file-viewer>`).
 * Escape or the close button dismisses it.
 *
 * The search palette is a separate standalone component (`<file-search>`).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import { StoreController } from "../../controllers/store-controller.js";
import "./file-viewer.js";
import "./file-tree.js";
import type { FileViewer } from "./file-viewer.js";
import { openFileSearchEvent } from "../events.js";

@customElement("file-browser")
export class FileBrowser extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _open = false;
  /** Whether the mobile tree slide-out panel is visible. */
  @state() private _mobileTreeOpen = false;

  /** Line range to apply once the viewer finishes loading content. */
  private _pendingHighlight: { startLine: number; endLine: number } | null = null;

  private _storeCtrl = new StoreController(this);

  @query("file-viewer") private _viewer!: FileViewer;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onGlobalKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this._onGlobalKeydown);
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._storeCtrl.store = this.store;
    }
  }

  /** Open the overlay (tree + viewer) without selecting a file. */
  open() {
    if (!this._open) {
      this.store?.reset();
      this._open = true;
      this._mobileTreeOpen = false;
      this.store?.fetchFiles();
    }
  }

  /** Open the overlay to a specific file, or switch files if already open. */
  openFile(path: string, lineRange?: { startLine: number; endLine: number }) {
    this.open();
    this._viewer?.resetHighlight();
    this._pendingHighlight = lineRange ?? null;
    this.store?.selectFile(path);
  }

  override updated() {
    // Push the pending highlight to the viewer once content has loaded
    if (this._pendingHighlight && this.store && !this.store.contentLoading && this._viewer) {
      const range = this._pendingHighlight;
      this._pendingHighlight = null;
      this._viewer.setHighlightRange(range);
    }
  }

  private close() {
    this._open = false;
    this._mobileTreeOpen = false;
    this.store?.reset();
    this._viewer?.resetHighlight();
  }

  private _openFileSearch() {
    this.dispatchEvent(openFileSearchEvent());
  }

  private _onGlobalKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this._open) {
      e.preventDefault();
      this.close();
    }
  };

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "file-browser-backdrop") {
      this.close();
    }
  }

  override render() {
    if (!this._open) return nothing;
    const path = this.store?.selectedFile;

    return html`
      <div
        id="file-browser-backdrop"
        class="fixed inset-0 z-[var(--layer-overlay)] flex items-center justify-center bg-black/70 sm:px-4"
        @click=${this.handleBackdropClick}
      >
        <div class="w-[100vw] h-[100dvh] min-w-0 min-h-0 sm:w-[90vw] sm:h-[90vh] overflow-hidden bg-zinc-800 sm:ring-1 sm:ring-zinc-600 sm:rounded-lg shadow-2xl flex flex-col">
          <!-- Header -->
          <div class="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 min-w-0">
            <!-- Mobile tree toggle -->
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 sm:hidden"
              @click=${() => { this._mobileTreeOpen = !this._mobileTreeOpen; }}
              title="Toggle file tree"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>
              </svg>
            </button>
            <!-- Mobile file search button -->
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 sm:hidden"
              @click=${this._openFileSearch}
              title="Search files"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="M13.3 16.3 15 18"/>
              </svg>
            </button>
            <span class="text-sm text-zinc-300 font-mono truncate flex-1">${path}</span>
            <kbd class="hidden sm:inline text-[10px] text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">Esc</kbd>
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
              @click=${() => this.close()}
              title="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>

          <!-- Body: tree sidebar + viewer -->
          <div class="flex flex-1 min-h-0 overflow-hidden relative">
            <!-- Tree sidebar (desktop: always visible, mobile: slide-out overlay) -->
            <div class="hidden sm:block w-[220px] shrink-0 border-r border-zinc-700 overflow-y-auto">
              <file-tree .store=${this.store}></file-tree>
            </div>

            <!-- Mobile tree slide-out panel -->
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
                     @open-in-browser=${() => { this._mobileTreeOpen = false; }}>
                  <file-tree .store=${this.store}></file-tree>
                </div>
                <div id="mobile-tree-backdrop" class="flex-1 bg-black/50"></div>
              </div>
            ` : nothing}

            <!-- Content viewer -->
            <file-viewer
              class="flex-1 min-w-0 flex flex-col"
              .store=${this.store}
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
