/**
 * File Search — standalone Cmd+P / Ctrl+P fuzzy file search palette.
 *
 * Owns its own open/close state. Registers the global keyboard shortcut
 * and exposes an `open()` method for programmatic triggers.
 * Selecting a file dispatches a bubbling `open-in-browser` event that
 * the app shell catches to open the file viewer overlay.
 *
 * Uses `<search-palette>` for the shared shell (input, keyboard nav,
 * container styling).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { openInBrowserEvent } from "./events.js";
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";
import "./search-palette.js";
import type { SearchPalette } from "./search-palette.js";

@customElement("file-search")
export class FileSearch extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _open = false;
  @state() private _query = "";
  @state() private _storeVersion = 0;

  @query("search-palette") private _palette!: SearchPalette;

  private _unsub: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.store) {
      this._unsub = this.store.subscribe(() => this._storeVersion++);
    }
    window.addEventListener("keydown", this._onKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    window.removeEventListener("keydown", this._onKeydown);
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("store") && this.store) {
      this._unsub?.();
      this._unsub = this.store.subscribe(() => this._storeVersion++);
    }

    if (changed.has("_open") && this._open) {
      this._query = "";
      this.store?.fetchFiles();
      this.updateComplete.then(() => {
        this._palette?.reset();
        this._palette?.focusInput();
      });
    }
  }

  /** Open the palette. */
  open() {
    this._open = true;
  }

  private close() {
    this._open = false;
  }

  private _onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "p") {
      e.preventDefault();
      this._open = !this._open;
    }
  };

  private get filteredFiles(): string[] {
    void this._storeVersion;
    return this.store?.filter(this._query) ?? [];
  }

  private handleQueryChange(e: CustomEvent<string>) {
    this._query = e.detail;
  }

  private handleConfirm(e: CustomEvent<number>) {
    const items = this.filteredFiles;
    if (items.length > 0 && e.detail < items.length) {
      this.close();
      this.dispatchEvent(openInBrowserEvent(items[e.detail]));
    }
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "file-search-backdrop") {
      this.close();
    }
  }

  // ---- Helpers --------------------------------------------------------------

  /**
   * Highlight the matching characters of a file path based on the current query.
   */
  private highlightPath(path: string): unknown {
    if (!this._query.trim()) return path;

    const q = this._query.toLowerCase();
    const lower = path.toLowerCase();
    const chars = path.split("");
    let qi = 0;

    const parts: Array<{ text: string; match: boolean }> = [];
    let current = "";
    let currentMatch = false;

    for (let i = 0; i < chars.length && qi <= q.length; i++) {
      const isMatch = qi < q.length && lower[i] === q[qi];
      if (isMatch) qi++;

      if (parts.length === 0 && current === "") {
        currentMatch = isMatch;
      }

      if (isMatch !== currentMatch) {
        parts.push({ text: current, match: currentMatch });
        current = "";
        currentMatch = isMatch;
      }
      current += chars[i];
    }
    if (current) parts.push({ text: current, match: currentMatch });

    return html`${parts.map((p) =>
      p.match
        ? html`<span class="text-blue-400 font-semibold">${p.text}</span>`
        : html`${p.text}`,
    )}`;
  }

  private renderFileItem = (index: number, _selected: boolean) => {
    const items = this.filteredFiles;
    const file = items[index];
    if (!file) return html``;

    return html`
      <div class="min-w-0 px-3 py-1.5 flex items-center gap-2 text-left">
        <span class="text-sm text-zinc-300 truncate font-mono">${this.highlightPath(file)}</span>
      </div>
    `;
  };

  private footerTemplate = html`
    <div class="px-3 py-1.5 border-t border-zinc-700 flex items-center gap-3 text-[10px] text-zinc-500">
      <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">↑↓</kbd> navigate</span>
      <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">Enter</kbd> open</span>
      <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">Esc</kbd> close</span>
    </div>
  `;

  // ---- Render ---------------------------------------------------------------

  override render() {
    if (!this._open) return nothing;

    const items = this.filteredFiles;

    return html`
      <div
        id="file-search-backdrop"
        class="fixed inset-0 z-[var(--layer-palette)] flex items-start justify-center px-4 pt-[15vh] bg-black/40"
        @click=${this.handleBackdropClick}
      >
        <search-palette
          placeholder="Search files by name..."
          .itemCount=${items.length}
          .loading=${this.store?.loading ?? false}
          loadingMessage="Loading file list..."
          emptyMessage="No files match your search"
          emptyNoQueryMessage="No files found"
          .renderItem=${this.renderFileItem}
          .footerTemplate=${this.footerTemplate}
          @query-change=${this.handleQueryChange}
          @confirm=${this.handleConfirm}
          @close=${() => this.close()}
        ></search-palette>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-search": FileSearch;
  }
}
