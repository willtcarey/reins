/**
 * File Browser — overlay with a directory tree (`<file-tree>`) and a `<file-viewer>`, shown while its
 * store's `browserOpen`. Escape, the backdrop or the close button close it. Once it has shown a file
 * it stays rendered while closed, so opening it again shows the file without reading it again.
 * Files chosen with Upload, or dropped on it, are written into the open file's folder.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import { StoreController } from "../../controllers/store-controller.js";
import type { FileView } from "../file-viewer/file-viewer.js";
import "../file-viewer/file-viewer.js";
import "./file-tree.js";
import { closeIcon, fileSearchIcon, menuIcon, uploadIcon } from "../../ui/icons.js";
import { showToast } from "../../ui/toast.js";

function isFileInput(target: EventTarget | null): target is HTMLInputElement {
  return target !== null && "files" in target && "value" in target;
}

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

  private _chooseFiles() {
    this.querySelector<HTMLInputElement>("input[data-role=upload-input]")?.click();
  }

  private _onFilesChosen = (e: Event) => {
    const input = e.target;
    if (!isFileInput(input)) return;
    if (input.files) void this._upload(input.files);
    // So choosing the same files again is a change too.
    input.value = "";
  };

  private _onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };

  private _onDrop = (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    void this._upload(files);
  };

  private async _upload(files: FileList | readonly File[]) {
    if (files.length === 0 || !this.store) return;
    const result = await this.store.upload(files);
    if ("error" in result) {
      showToast(result.error, "error");
      return;
    }
    const count = result.uploaded.length;
    showToast(`Uploaded ${count} file${count === 1 ? "" : "s"}.`, "success");
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
    if (!store?.browserOpen && !store?.view) return nothing;
    const path = store.path;
    const checkout = store.source?.path ?? "";
    const otherNode = store.otherNode;

    return html`
      <div
        id="file-browser-backdrop"
        class="fixed inset-0 z-[var(--layer-overlay)] ${store.browserOpen ? "flex" : "hidden"} items-center justify-center bg-black/70 sm:px-4"
        @click=${this.handleBackdropClick}
      >
        <div
          class="w-[100vw] h-[100dvh] min-w-0 min-h-0 sm:w-[90vw] sm:h-[90vh] overflow-hidden bg-zinc-800 sm:ring-1 sm:ring-zinc-600 sm:rounded-lg shadow-2xl flex flex-col"
          @dragover=${this._onDragOver}
          @drop=${this._onDrop}
        >
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
            <span class="text-sm text-zinc-400 truncate flex-1" title=${otherNode ? `${checkout} on ${otherNode}` : checkout}>${checkout.slice(checkout.lastIndexOf("/") + 1)}${otherNode ? html`<span class="text-zinc-500"> · ${otherNode}</span>` : nothing}</span>
            ${store.uploadProgress === null ? nothing : html`<span class="text-xs text-zinc-400 shrink-0">Uploading ${store.uploadProgress}%</span>`}
            <input data-role="upload-input" type="file" multiple hidden @change=${this._onFilesChosen} />
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-default"
              ?disabled=${store.uploadProgress !== null}
              @click=${this._chooseFiles}
              title=${store.uploadFolder === "." ? "Upload files into the checkout's root" : `Upload files into ${store.uploadFolder}/`}
            >
              ${uploadIcon()}
            </button>
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
              container="file-browser"
              .files=${store.files}
              .view=${store.view}
              @open-in-inspector=${(e: CustomEvent<FileView>) => store.openInInspector(e.detail)}
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
