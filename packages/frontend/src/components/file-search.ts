/**
 * File Search — fuzzy file search palette for the file browser overlay.
 *
 * Renders a search input with a filtered results list. The parent
 * `<file-browser>` owns open/close state and the store; this component
 * is purely presentational + keyboard navigation.
 *
 * Fires:
 *   `file-select` — when the user picks a file (detail: file path string)
 *   `close`       — when the user presses Escape
 */

import { LitElement, html } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";

@customElement("file-search")
export class FileSearch extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _query = "";
  @state() private _selectedIndex = 0;
  @state() private _storeVersion = 0;

  @query("#file-search-input") private _input!: HTMLInputElement;

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
    requestAnimationFrame(() => this._input?.focus());
  }

  /** Reset query and selection. Called by parent when re-entering search mode. */
  reset() {
    this._query = "";
    this._selectedIndex = 0;
  }

  private get filteredFiles(): string[] {
    void this._storeVersion;
    return this.store?.filter(this._query) ?? [];
  }

  private handleInput(e: Event) {
    if (!(e.target instanceof HTMLInputElement)) return;
    this._query = e.target.value;
    this._selectedIndex = 0;
  }

  private handleKeydown(e: KeyboardEvent) {
    const items = this.filteredFiles;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this._selectedIndex = items.length > 0 ? (this._selectedIndex + 1) % items.length : 0;
        this.scrollSelectedIntoView();
        break;
      case "ArrowUp":
        e.preventDefault();
        this._selectedIndex =
          items.length > 0 ? (this._selectedIndex - 1 + items.length) % items.length : 0;
        this.scrollSelectedIntoView();
        break;
      case "Enter":
        e.preventDefault();
        if (items.length > 0) {
          this.dispatchEvent(
            new CustomEvent("file-select", {
              detail: items[this._selectedIndex],
              bubbles: true,
              composed: true,
            }),
          );
        }
        break;
      case "Escape":
        e.preventDefault();
        this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
        break;
    }
  }

  private scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const el = this.querySelector(`[data-file-index="${this._selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  private selectFile(path: string) {
    this.dispatchEvent(
      new CustomEvent("file-select", { detail: path, bubbles: true, composed: true }),
    );
  }

  // ---- Helpers --------------------------------------------------------------

  private fileIcon(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const iconMap: Record<string, string> = {
      ts: "📘",
      tsx: "📘",
      js: "📒",
      jsx: "📒",
      json: "📋",
      md: "📝",
      css: "🎨",
      html: "🌐",
      py: "🐍",
      rb: "💎",
      go: "🔵",
      rs: "🦀",
      sh: "⚙️",
      yml: "⚙️",
      yaml: "⚙️",
    };
    return iconMap[ext] ?? "📄";
  }

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

  // ---- Render ---------------------------------------------------------------

  override render() {
    const items = this.filteredFiles;

    return html`
      <div class="w-full max-w-2xl mt-[10vh] bg-zinc-800 ring-1 ring-zinc-600 rounded-lg shadow-2xl flex flex-col max-h-[70vh]">
        <!-- Search input -->
        <div class="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-700">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               class="text-zinc-400 shrink-0">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            id="file-search-input"
            name="file-search-nonce"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
            placeholder="Search files by name..."
            .value=${this._query}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
          />
          <kbd class="hidden sm:inline text-[10px] text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        <!-- Results list -->
        <div class="overflow-y-auto flex-1 py-1">
          ${this.store?.loading
            ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">Loading file list...</div>`
            : items.length === 0
              ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">
                  ${this._query ? "No files match your search" : "No files found"}
                </div>`
              : items.map(
                  (file, i) => html`
                    <button
                      data-file-index=${i}
                      class="w-full px-3 py-1.5 flex items-center gap-2 text-left cursor-pointer transition-colors ${
                        i === this._selectedIndex ? "bg-zinc-700" : "hover:bg-zinc-700/50"
                      }"
                      @click=${() => this.selectFile(file)}
                      @mouseenter=${() => (this._selectedIndex = i)}
                    >
                      <span class="text-xs shrink-0">${this.fileIcon(file)}</span>
                      <span class="text-sm text-zinc-300 truncate font-mono">${this.highlightPath(file)}</span>
                    </button>
                  `,
                )}
        </div>

        <!-- Footer hint -->
        <div class="px-3 py-1.5 border-t border-zinc-700 flex items-center gap-3 text-[10px] text-zinc-500">
          <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">↑↓</kbd> navigate</span>
          <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">Enter</kbd> open</span>
          <span><kbd class="bg-zinc-700 px-1 py-0.5 rounded">Esc</kbd> close</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-search": FileSearch;
  }
}
