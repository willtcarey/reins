/**
 * File Browser — overlay shell for file search + viewer.
 *
 * Owns open/close state, the global Cmd+P / Ctrl+P keyboard shortcut,
 * and mode routing between `<file-search>` and `<file-viewer>`.
 * Delegates all search UI and file rendering to child components.
 *
 * Exposes `open()` and `openFile(path)` for programmatic triggers.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";
import "./file-search.js";
import type { FileSearch } from "./file-search.js";
import "./file-viewer.js";
import type { FileViewer } from "./file-viewer.js";

@customElement("file-browser")
export class FileBrowser extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _open = false;
  @state() private _mode: "search" | "viewer" = "search";

  @query("file-search") private _search!: FileSearch;
  @query("file-viewer") private _viewer!: FileViewer;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onGlobalKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this._onGlobalKeydown);
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("_open") && this._open && this._mode === "search") {
      this.store?.fetchFiles();
      // Wait for render, then focus the search input
      this.updateComplete.then(() => this._search?.focusInput());
    }
  }

  /** Open the overlay to the search palette. */
  open() {
    this.store?.reset();
    this._mode = "search";
    this._open = true;
  }

  /** Open the overlay directly to a specific file. */
  openFile(path: string) {
    this.store?.reset();
    this._mode = "viewer";
    this._open = true;
    this.store?.fetchFiles();
    this.store?.selectFile(path);
  }

  private close() {
    this._open = false;
    this.store?.reset();
  }

  private switchToSearch() {
    this._mode = "search";
    this.store?.reset();
    this._viewer?.resetHighlight();
    this.updateComplete.then(() => {
      this._search?.reset();
      this._search?.focusInput();
    });
  }

  private _onGlobalKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "p") {
      e.preventDefault();
      if (this._open) {
        if (this._mode === "viewer") {
          this.switchToSearch();
        } else {
          this.close();
        }
      } else {
        this.open();
      }
    }

    if (e.key === "Escape" && this._open) {
      e.preventDefault();
      if (this._mode === "viewer") {
        this.switchToSearch();
      } else {
        this.close();
      }
    }
  };

  private handleFileSelect(e: CustomEvent<string>) {
    this._mode = "viewer";
    this._viewer?.resetHighlight();
    this.store?.selectFile(e.detail);
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "file-browser-backdrop") {
      this.close();
    }
  }

  override render() {
    if (!this._open) return nothing;

    return html`
      <div
        id="file-browser-backdrop"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
        @click=${this.handleBackdropClick}
        @close=${() => this.close()}
      >
        ${this._mode === "search"
          ? html`
              <file-search
                .store=${this.store}
                @file-select=${this.handleFileSelect}
                @close=${() => this.close()}
              ></file-search>
            `
          : html`
              <file-viewer
                .store=${this.store}
                @back=${() => this.switchToSearch()}
                @close=${() => this.close()}
              ></file-viewer>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-browser": FileBrowser;
  }
}
