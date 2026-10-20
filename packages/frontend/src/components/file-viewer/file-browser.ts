/**
 * File Browser — overlay with tree sidebar and file content viewer.
 *
 * Shown while `request` is set; the workspace owns it and sets it from
 * `open-in-browser` and `open-file-browser` events. Renders a header bar, a
 * directory tree sidebar (`<file-tree>`), and a content viewer (`<file-viewer>`)
 * from the workspace's `FileModel`. Escape, the backdrop or the close button
 * ask to close it with `file-browser-close`.
 *
 * The search palette is a separate standalone component (`<file-search>`).
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { FileModel } from "../../models/stores/file-model.js";
import { StoreController } from "../../controllers/store-controller.js";
import "./file-viewer.js";
import "./file-tree.js";
import type { HighlightRequest } from "./file-viewer-code.js";
import { fileBrowserCloseEvent, openFileSearchEvent, openViewEvent } from "../events.js";
import type { FileViewMode } from "../events.js";
import { closeIcon, downloadIcon, fileSearchIcon, menuIcon, panelRightIcon } from "../../ui/icons.js";

export interface FileBrowserRequest {
  /** The file shown, or null for the tree alone. */
  path: string | null;
  initialView: FileViewMode;
  highlight: HighlightRequest | null;
}

@customElement("file-browser")
export class FileBrowser extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileModel;
  @property({ attribute: false }) request: FileBrowserRequest | null = null;

  /** Whether the mobile tree slide-out panel is visible. */
  @state() private _mobileTreeOpen = false;

  private _storeCtrl = new StoreController(this);

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
    if (!changed.has("request")) return;
    const previous = changed.get("request");
    const path = this.request?.path;
    if (!previous) this._mobileTreeOpen = false;
    if (path && path !== previous?.path) {
      // Opening a file reads it again, so the browser shows the checkout as it is now.
      void this.store?.loadFile(path, { refresh: true });
      void this.store?.expandToPath(path);
    }
  }

  private close() {
    this.dispatchEvent(fileBrowserCloseEvent());
  }

  private _openFileSearch() {
    const projectId = this.store?.projectId;
    if (projectId == null) return;
    this.dispatchEvent(openFileSearchEvent(projectId));
  }

  private _openInInspector(path: string) {
    const highlight = this.request?.highlight;
    this.dispatchEvent(openViewEvent(
      highlight
        ? { view: "file", path, startLine: highlight.startLine, endLine: highlight.endLine }
        : { view: "file", path },
      { in: "inspector" },
    ));
    this.close();
  }

  private _onGlobalKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.request) {
      e.preventDefault();
      this.close();
    }
  };

  private _onHtmlPreviewEscape = () => {
    if (this.request) this.close();
  };

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "file-browser-backdrop") {
      this.close();
    }
  }

  override render() {
    const request = this.request;
    if (!request) return nothing;
    const path = request.path;
    const contentUrl = path ? this.store?.contentUrl(path) : null;
    const downloadUrl = contentUrl ? `${contentUrl}&download=1` : null;

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
                @click=${() => this._openInInspector(path)}
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
              <file-tree .store=${this.store} .activeFile=${path}></file-tree>
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
                     @open-in-browser=${() => { this._mobileTreeOpen = false; }}>
                  <file-tree .store=${this.store} .activeFile=${path}></file-tree>
                </div>
                <div id="mobile-tree-backdrop" class="flex-1 bg-black/50"></div>
              </div>
            ` : nothing}

            <file-viewer
              class="flex-1 min-w-0 flex flex-col"
              .path=${path ?? ""}
              .file=${path ? this.store?.file(path) : undefined}
              .contentUrl=${contentUrl ?? null}
              .initialView=${request.initialView}
              .highlightRequest=${request.highlight}
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
