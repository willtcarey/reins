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
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";
import { StoreController } from "../controllers/store-controller.js";
import "./file-viewer.js";
import "./file-tree.js";
import type { FileViewer } from "./file-viewer.js";

@customElement("file-browser")
export class FileBrowser extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _open = false;

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

  /** Open the overlay to a specific file, or switch files if already open. */
  openFile(path: string) {
    if (!this._open) {
      this.store?.reset();
      this._open = true;
      this.store?.fetchFiles();
    }
    this._viewer?.resetHighlight();
    this.store?.selectFile(path);
  }

  private close() {
    this._open = false;
    this.store?.reset();
    this._viewer?.resetHighlight();
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
          <div class="flex flex-1 min-h-0 overflow-hidden">
            <!-- Tree sidebar -->
            <div class="hidden sm:block w-[220px] shrink-0 border-r border-zinc-700 overflow-y-auto">
              <file-tree .store=${this.store}></file-tree>
            </div>

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
