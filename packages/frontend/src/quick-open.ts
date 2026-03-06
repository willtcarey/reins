/**
 * Quick Open — Cmd+K / Ctrl+K quick navigation overlay.
 *
 * Owns its own open/close state. Registers the global keyboard shortcut
 * and exposes an `open()` method for programmatic triggers (e.g. mobile
 * search button). All data fetching, filtering, and recent session
 * tracking lives in QuickOpenStore.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { ActivityState } from "./stores/app-store.js";
import type { QuickOpenStore, PaletteItem } from "./stores/quick-open-store.js";
import { navigateToSession } from "./router.js";
import { formatRelativeDate } from "./format.js";

@customElement("quick-open")
export class QuickOpen extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) activityMap: Map<string, ActivityState> = new Map();
  @property({ attribute: false }) store!: QuickOpenStore;

  @state() private _open = false;
  @state() private _query = "";
  @state() private _selectedIndex = 0;
  @state() private _storeVersion = 0;

  @query("#palette-input") private _input!: HTMLInputElement;

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
    // Re-subscribe if store changes
    if (changed.has("store") && this.store) {
      this._unsub?.();
      this._unsub = this.store.subscribe(() => this._storeVersion++);
    }

    if (changed.has("_open") && this._open) {
      this._query = "";
      this._selectedIndex = 0;
      this.store?.fetchItems();
      requestAnimationFrame(() => {
        this._input?.focus();
      });
    }
  }

  /** Open the palette. Called by parent for programmatic triggers (e.g. mobile button). */
  open() {
    this._open = true;
  }

  private close() {
    this._open = false;
  }

  private _onKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      this._open = !this._open;
    }
  };

  private get filteredItems(): PaletteItem[] {
    void this._storeVersion;
    return this.store?.filter(this._query) ?? [];
  }

  private handleInput(e: Event) {
    this._query = (e.target as HTMLInputElement).value;
    this._selectedIndex = 0;
  }

  private handleKeydown(e: KeyboardEvent) {
    const items = this.filteredItems;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this._selectedIndex = items.length > 0 ? (this._selectedIndex + 1) % items.length : 0;
        this.scrollSelectedIntoView();
        break;
      case "ArrowUp":
        e.preventDefault();
        this._selectedIndex = items.length > 0 ? (this._selectedIndex - 1 + items.length) % items.length : 0;
        this.scrollSelectedIntoView();
        break;
      case "Enter":
        e.preventDefault();
        if (items.length > 0) {
          this.selectItem(items[this._selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        this.close();
        break;
    }
  }

  private scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const el = this.querySelector(`[data-palette-index="${this._selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  private selectItem(item: PaletteItem) {
    this.store?.recordVisit(item.sessionId);
    this.close();
    navigateToSession(item.sessionId);
  }

  private handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement)?.id === "palette-backdrop") {
      this.close();
    }
  }

  private truncate(text: string | null, max = 80): string {
    if (!text) return "";
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  private renderActivityDot(sessionId: string) {
    const activity = this.activityMap.get(sessionId);
    if (!activity) return nothing;

    if (activity === "running") {
      return html`<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" title="Running"></span>`;
    }
    return html`<span class="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="Finished"></span>`;
  }

  override render() {
    if (!this._open) return nothing;

    const items = this.filteredItems;

    return html`
      <div
        id="palette-backdrop"
        class="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/70"
        @click=${this.handleBackdropClick}
      >
        <div class="w-full max-w-xl bg-zinc-800 ring-1 ring-zinc-600 rounded-lg shadow-2xl flex flex-col">
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
              class="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
              placeholder="Search sessions..."
              .value=${this._query}
              @input=${this.handleInput}
              @keydown=${this.handleKeydown}
            />
            <kbd class="hidden sm:inline text-[10px] text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">ESC</kbd>
          </div>

          <!-- Results list -->
          <div class="overflow-y-auto max-h-96 py-1.5">
            ${this.store?.loading
              ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">Loading...</div>`
              : items.length === 0
                ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">No sessions found</div>`
                : items.map(
                    (item, i) => html`
                      <button
                        data-palette-index=${i}
                        class="w-full px-3 py-2.5 flex items-center gap-3 text-left cursor-pointer transition-colors ${
                          i === this._selectedIndex
                            ? "bg-zinc-700"
                            : "hover:bg-zinc-700/50"
                        }"
                        @click=${() => this.selectItem(item)}
                        @mouseenter=${() => (this._selectedIndex = i)}
                      >
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-1.5 text-sm truncate">
                            <span class="font-medium text-zinc-200">${item.projectName}</span>
                            <span class="text-zinc-500">/</span>
                            <span class="font-medium text-zinc-300">${item.taskId === null ? "Assistant" : item.taskTitle}</span>
                          </div>
                          <div class="flex items-center gap-2 text-xs text-zinc-500 mt-0.5">
                            ${item.taskId !== null && item.firstMessage
                              ? html`<span class="truncate">${this.truncate(item.firstMessage)}</span>`
                              : nothing}
                            <span class="flex-1"></span>
                            <span class="shrink-0">${formatRelativeDate(item.updatedAt)}</span>
                          </div>
                        </div>
                        ${this.renderActivityDot(item.sessionId)}
                      </button>
                    `
                  )}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "quick-open": QuickOpen;
  }
}
