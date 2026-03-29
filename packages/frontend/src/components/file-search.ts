/**
 * File Search — fuzzy file search palette for the file browser overlay.
 *
 * Renders a search input with a filtered results list using `<search-palette>`.
 * The parent `<file-browser>` owns open/close state and the store; this
 * component is purely presentational + keyboard navigation.
 *
 * Fires:
 *   `file-select` — when the user picks a file (detail: file path string)
 *   `close`       — when the user presses Escape
 */

import { LitElement, html } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";
import "./search-palette.js";
import type { SearchPalette } from "./search-palette.js";

@customElement("file-search")
export class FileSearch extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _query = "";
  @state() private _storeVersion = 0;

  @query("search-palette") private _palette!: SearchPalette;

  private _unsub: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.store) {
      this._unsub = this.store.subscribe(() => this._storeVersion++);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("store") && this.store) {
      this._unsub?.();
      this._unsub = this.store.subscribe(() => this._storeVersion++);
    }
  }

  /** Focus the search input. Called by parent after opening. */
  focusInput() {
    this._palette?.focusInput();
  }

  /** Reset query and selection. Called by parent when re-entering search mode. */
  reset() {
    this._query = "";
    this._palette?.reset();
  }

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
      this.dispatchEvent(
        new CustomEvent("file-select", {
          detail: items[e.detail],
          bubbles: true,
          composed: true,
        }),
      );
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
    const items = this.filteredFiles;

    return html`
      <search-palette
        placeholder="Search files by name..."
        containerClass="w-full max-w-2xl mt-[10vh] max-h-[70vh]"
        resultsClass="flex-1"
        .itemCount=${items.length}
        .loading=${this.store?.loading ?? false}
        loadingMessage="Loading file list..."
        emptyMessage="No files match your search"
        emptyNoQueryMessage="No files found"
        .renderItem=${this.renderFileItem}
        .footerTemplate=${this.footerTemplate}
        @query-change=${this.handleQueryChange}
        @confirm=${this.handleConfirm}
        @close=${(e: Event) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true })); }}
      ></search-palette>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-search": FileSearch;
  }
}
