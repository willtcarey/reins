/**
 * Search Palette — shared shell for palette-style overlays.
 *
 * Renders a rounded container with a search input (magnifying glass + ESC hint),
 * a scrollable results area, and an optional footer. Manages query state,
 * keyboard navigation (↑/↓/Enter/Escape), and scroll-into-view for the
 * selected item.
 *
 * Consumers provide a `renderItem` callback to render each result row and
 * react to events:
 *   `query-change` — detail: query string
 *   `confirm`      — detail: selected index
 *   `close`        — user pressed Escape
 *
 * No shadow DOM — uses `createRenderRoot() { return this; }` like the rest
 * of the app.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { TemplateResult } from "lit";

export type PaletteRenderItem = (index: number, selected: boolean) => TemplateResult | typeof nothing;

@customElement("search-palette")
export class SearchPalette extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Placeholder text for the search input. */
  @property() placeholder = "Search...";

  /** Number of items in the results list. Used for keyboard nav bounds. */
  @property({ type: Number }) itemCount = 0;

  /** Whether the results are loading. */
  @property({ type: Boolean }) loading = false;

  /** Message shown while loading. */
  @property() loadingMessage = "Loading...";

  /** Message shown when no results match. */
  @property() emptyMessage = "No results found";

  /** Message shown when there's no query and no items. */
  @property() emptyNoQueryMessage = "";

  /** Additional CSS classes for the outer container (e.g. max-height constraints). */
  @property() containerClass = "";

  /** Extra CSS classes for the results scroll area. */
  @property() resultsClass = "max-h-96";

  /** Callback to render each result item. */
  @property({ attribute: false }) renderItem?: PaletteRenderItem;

  /** Optional footer template (e.g. keyboard hint bar). */
  @property({ attribute: false }) footerTemplate?: TemplateResult | typeof nothing;

  @state() private _query = "";
  @state() private _selectedIndex = 0;

  @query("#palette-input") private _input!: HTMLInputElement;

  /** Current query value (read-only from outside). */
  get query() {
    return this._query;
  }

  /** Current selected index (read-only from outside). */
  get selectedIndex() {
    return this._selectedIndex;
  }

  /** Focus the search input. */
  focusInput() {
    requestAnimationFrame(() => this._input?.focus());
  }

  /** Reset query and selection to initial state. */
  reset() {
    this._query = "";
    this._selectedIndex = 0;
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    // Clamp selectedIndex when itemCount shrinks
    if (changed.has("itemCount") && this._selectedIndex >= this.itemCount) {
      this._selectedIndex = Math.max(0, this.itemCount - 1);
    }
  }

  // ---- Input & keyboard -----------------------------------------------------

  private handleInput(e: Event) {
    if (!(e.target instanceof HTMLInputElement)) return;
    this._query = e.target.value;
    this._selectedIndex = 0;
    this.dispatchEvent(
      new CustomEvent("query-change", {
        detail: this._query,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleKeydown(e: KeyboardEvent) {
    const count = this.itemCount;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this._selectedIndex = count > 0 ? (this._selectedIndex + 1) % count : 0;
        this.scrollSelectedIntoView();
        break;
      case "ArrowUp":
        e.preventDefault();
        this._selectedIndex = count > 0 ? (this._selectedIndex - 1 + count) % count : 0;
        this.scrollSelectedIntoView();
        break;
      case "Enter":
        e.preventDefault();
        if (count > 0) {
          this.dispatchEvent(
            new CustomEvent("confirm", {
              detail: this._selectedIndex,
              bubbles: true,
              composed: true,
            }),
          );
        }
        break;
      case "Escape":
        e.preventDefault();
        this.dispatchEvent(
          new CustomEvent("close", { bubbles: true, composed: true }),
        );
        break;
    }
  }

  private scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const el = this.querySelector(`[data-palette-index="${this._selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    const emptyMsg = this._query ? this.emptyMessage : (this.emptyNoQueryMessage || this.emptyMessage);

    return html`
      <div class="w-[42rem] max-w-[calc(100vw-2rem)] bg-zinc-800 ring-1 ring-zinc-600 rounded-lg shadow-2xl flex flex-col ${this.containerClass}">
        <!-- Search input -->
        <div class="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-700">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               class="text-zinc-400 shrink-0">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            id="palette-input"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
            .placeholder=${this.placeholder}
            .value=${this._query}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
          />
          <kbd class="hidden sm:inline text-[10px] text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        <!-- Results list -->
        <div class="overflow-y-auto ${this.resultsClass} py-1">
          ${this.loading
            ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">${this.loadingMessage}</div>`
            : this.itemCount === 0
              ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">${emptyMsg}</div>`
              : this.renderItems()}
        </div>

        <!-- Optional footer -->
        ${this.footerTemplate ?? nothing}
      </div>
    `;
  }

  private renderItems() {
    if (!this.renderItem) return nothing;
    const items = [];
    for (let i = 0; i < this.itemCount; i++) {
      items.push(html`
        <button
          data-palette-index=${i}
          class="w-full cursor-pointer transition-colors ${
            i === this._selectedIndex ? "bg-zinc-700" : "hover:bg-zinc-700/50"
          }"
          @click=${() => this.dispatchConfirm(i)}
          @mouseenter=${() => { this._selectedIndex = i; }}
        >
          ${this.renderItem(i, i === this._selectedIndex)}
        </button>
      `);
    }
    return items;
  }

  private dispatchConfirm(index: number) {
    this._selectedIndex = index;
    this.dispatchEvent(
      new CustomEvent("confirm", {
        detail: index,
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "search-palette": SearchPalette;
  }
}
