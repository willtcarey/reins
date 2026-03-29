/**
 * Quick Open — Cmd+K / Ctrl+K quick navigation overlay.
 *
 * Owns its own open/close state. Registers the global keyboard shortcut
 * and exposes an `open()` method for programmatic triggers (e.g. mobile
 * search button). All data fetching, filtering, and recent session
 * tracking lives in QuickOpenStore.
 *
 * Uses `<search-palette>` for the shared shell (input, keyboard nav,
 * container styling).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { ActivityState } from "../models/stores/app-store.js";
import type { QuickOpenStore, PaletteItem } from "../models/stores/quick-open-store.js";
import { navigateToSession } from "../models/router.js";
import { formatRelativeDate } from "../models/format.js";
import "./search-palette.js";
import type { SearchPalette } from "./search-palette.js";

@customElement("quick-open")
export class QuickOpen extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) activityMap: Map<string, ActivityState> = new Map();
  @property({ attribute: false }) store!: QuickOpenStore;

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
    // Re-subscribe if store changes
    if (changed.has("store") && this.store) {
      this._unsub?.();
      this._unsub = this.store.subscribe(() => this._storeVersion++);
    }

    if (changed.has("_open") && this._open) {
      this._query = "";
      this.store?.fetchItems();
      this.updateComplete.then(() => {
        this._palette?.reset();
        this._palette?.focusInput();
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

  private handleQueryChange(e: CustomEvent<string>) {
    this._query = e.detail;
  }

  private handleConfirm(e: CustomEvent<number>) {
    const items = this.filteredItems;
    if (items.length > 0 && e.detail < items.length) {
      this.selectItem(items[e.detail]);
    }
  }

  private selectItem(item: PaletteItem) {
    this.store?.recordVisit(item.sessionId);
    this.close();
    navigateToSession(item.sessionId);
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "palette-backdrop") {
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

  private renderSessionItem = (index: number, _selected: boolean) => {
    const items = this.filteredItems;
    const item = items[index];
    if (!item) return html``;

    return html`
      <div class="px-3 py-2.5 flex items-center gap-3 text-left">
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
      </div>
    `;
  };

  override render() {
    if (!this._open) return nothing;

    const items = this.filteredItems;

    return html`
      <div
        id="palette-backdrop"
        class="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/70"
        @click=${this.handleBackdropClick}
      >
        <search-palette
          placeholder="Search sessions..."
          containerClass="w-full max-w-xl"
          .itemCount=${items.length}
          .loading=${this.store?.loading ?? false}
          emptyMessage="No sessions found"
          .renderItem=${this.renderSessionItem}
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
    "quick-open": QuickOpen;
  }
}
