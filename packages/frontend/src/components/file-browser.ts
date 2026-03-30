/**
 * File Browser — viewer overlay for displaying file contents.
 *
 * A simple overlay shell around `<file-viewer>`. Opens via `openFile(path)`
 * (called by the app shell in response to `open-in-browser` events).
 * Escape or the close button dismisses it.
 *
 * The search palette is a separate standalone component (`<file-search>`).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";
import "./file-viewer.js";
import type { FileViewer } from "./file-viewer.js";

@customElement("file-browser")
export class FileBrowser extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _open = false;

  @query("file-viewer") private _viewer!: FileViewer;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onGlobalKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this._onGlobalKeydown);
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

    return html`
      <div
        id="file-browser-backdrop"
        class="fixed inset-0 z-[var(--layer-overlay)] flex items-center justify-center bg-black/70 px-4"
        @click=${this.handleBackdropClick}
        @close=${() => this.close()}
      >
        <file-viewer
          .store=${this.store}
          @close=${() => this.close()}
        ></file-viewer>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-browser": FileBrowser;
  }
}
