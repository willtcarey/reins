/**
 * File Search — Cmd+P / Ctrl+P fuzzy file search palette, part of the file browser: shown while its
 * store's `searchOpen`. Choosing a file shows it in the file browser; ⌘/Ctrl+Enter or a row's
 * Inspector button opens it in the Inspector instead (`open-view`).
 *
 * Uses `<search-palette>` for the shared shell (input, keyboard nav,
 * container styling).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { openViewEvent } from "../events.js";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import { panelRightIcon } from "../../ui/icons.js";
import { fuzzyMatch } from "../../models/stores/quick-open-store.js";
import "../search-palette.js";
import type { SearchPalette } from "../search-palette.js";

@customElement("file-search")
export class FileSearch extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: FileBrowserStore | null = null;

  @query("search-palette") private _palette!: SearchPalette;

  private _storeCtrl = new StoreController<FileBrowserStore>(this);
  private _wasOpen = false;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) this._storeCtrl.store = this.store;
  }

  override updated() {
    const open = this.store?.searchOpen ?? false;
    if (open && !this._wasOpen) {
      void this.updateComplete.then(() => {
        this._palette?.reset();
        this._palette?.focusInput();
      });
    }
    this._wasOpen = open;
  }

  private close() {
    this.store?.closeSearch();
  }

  private handleQueryChange(e: CustomEvent<string>) {
    this.store?.setQuery(e.detail);
  }

  private handleConfirm(e: CustomEvent<number>) {
    const path = this.store?.results[e.detail];
    if (path != null) this.store?.select(path);
  }

  private openInInspector(index: number) {
    const store = this.store;
    const path = store?.results[index];
    if (!store?.source || path == null) return;
    this.close();
    this.dispatchEvent(openViewEvent({ view: "file", path }, { in: "inspector" }, store.source.projectId));
  }

  private renderItemAction = (index: number) => {
    const path = this.store?.results[index];
    if (path == null) return nothing;
    return html`
      <button
        class="shrink-0 px-2.5 text-zinc-500 hover:text-zinc-200 cursor-pointer transition-colors"
        title="Open in Inspector"
        @click=${() => this.openInInspector(index)}
      >${panelRightIcon()}<span class="sr-only">Open ${path} in Inspector</span></button>
    `;
  };

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "file-search-backdrop") {
      this.close();
    }
  }

  // ---- Helpers --------------------------------------------------------------

  /**
   * Highlight the matching characters of a file path based on the current query.
   * When the query matches the basename, highlights only within the basename
   * portion to stay consistent with how results are scored.
   */
  private highlightPath(path: string): unknown {
    const typed = this.store?.query ?? "";
    if (!typed.trim()) return path;

    const q = typed.toLowerCase();

    // If the query matches the basename, highlight only in the basename portion.
    const slashIdx = path.lastIndexOf("/");
    const basename = path.slice(slashIdx + 1);
    const basenameMatches = fuzzyMatch(q, basename) !== null;

    const startIdx = basenameMatches ? slashIdx + 1 : 0;
    const lower = path.toLowerCase();
    let qi = 0;

    const parts: Array<{ text: string; match: boolean }> = [];
    let current = "";
    let currentMatch = false;

    // Emit prefix before the match region unchanged
    if (startIdx > 0) {
      parts.push({ text: path.slice(0, startIdx), match: false });
    }

    for (let i = startIdx; i < path.length && qi <= q.length; i++) {
      const isMatch = qi < q.length && lower[i] === q[qi];
      if (isMatch) qi++;

      if (parts.length === 0 && current === "") {
        currentMatch = isMatch;
      } else if (current === "") {
        currentMatch = isMatch;
      }

      if (isMatch !== currentMatch) {
        parts.push({ text: current, match: currentMatch });
        current = "";
        currentMatch = isMatch;
      }
      current += path[i];
    }
    if (current) parts.push({ text: current, match: currentMatch });

    return html`${parts.map((p) =>
      p.match
        ? html`<span class="text-blue-400 font-semibold">${p.text}</span>`
        : html`${p.text}`,
    )}`;
  }

  private renderFileItem = (index: number, _selected: boolean) => {
    const file = this.store?.results[index];
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
      <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">⌘Enter</kbd> open in Inspector</span>
      <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">Esc</kbd> close</span>
    </div>
  `;

  // ---- Render ---------------------------------------------------------------

  override render() {
    const store = this.store;
    if (!store?.searchOpen) return nothing;

    const items = store.results;

    return html`
      <div
        id="file-search-backdrop"
        class="fixed inset-0 z-[var(--layer-palette)] flex items-start justify-center px-4 pt-[15vh] bg-black/40"
        @click=${this.handleBackdropClick}
      >
        <search-palette
          placeholder="Search files by name..."
          .itemCount=${items.length}
          .loading=${store.listing.loading && !store.listing.data}
          loadingMessage="Loading file list..."
          emptyMessage="No files match your search"
          emptyNoQueryMessage="No files found"
          .renderItem=${this.renderFileItem}
          .renderItemAction=${this.renderItemAction}
          .footerTemplate=${this.footerTemplate}
          @query-change=${this.handleQueryChange}
          @confirm=${this.handleConfirm}
          @palette-alternate-confirm=${(e: CustomEvent<number>) => this.openInInspector(e.detail)}
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
