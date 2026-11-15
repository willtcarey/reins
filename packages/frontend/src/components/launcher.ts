/**
 * The Launcher (Cmd+K / Ctrl+K, or the sidebar's magnifying glass): one list of what extensions give
 * (docs/features/launcher.md), gathered and ranked by `LauncherStore`, in the `<search-palette>` shell.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { LauncherItem } from "@reins/sdk";
import type { LauncherStore } from "../models/stores/launcher-store.js";
import type { SearchPalette } from "./search-palette.js";
import { statusDot } from "../ui/status-dot.js";
import { showToast } from "../ui/toast.js";
import "./search-palette.js";
import "./view-mount.js";

@customElement("app-launcher")
export class Launcher extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: LauncherStore;

  @state() private _open = false;
  @state() private _query = "";
  @state() private _items: LauncherItem[] = [];

  @query("search-palette") private _palette!: SearchPalette;

  private _unsub: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
    window.removeEventListener("keydown", this._onKeydown);
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._unsub?.();
      this._unsub = this.store?.subscribe(() => this._refilter()) ?? null;
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("_open") && this._open) {
      this._query = "";
      void this.store?.gather();
      this._refilter();
      void this.updateComplete.then(() => {
        this._palette?.reset();
        this._palette?.focusInput();
      });
    }
  }

  /** For triggers other than the shortcut (the sidebar's button). */
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

  private _refilter() {
    this._items = this.store?.filter(this._query) ?? [];
  }

  private handleQueryChange(e: CustomEvent<string>) {
    this._query = e.detail;
    this._refilter();
  }

  private handleConfirm(e: CustomEvent<number>) {
    const item = this._items[e.detail];
    if (item) this.runItem(item);
  }

  private runItem(item: LauncherItem) {
    this.close();
    this.store.run(item).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), "error");
    });
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target instanceof HTMLElement && e.target.id === "palette-backdrop") {
      this.close();
    }
  }

  private renderStatus(item: LauncherItem) {
    if (item.status === "active") return statusDot("success", { label: "Running", pulse: true });
    if (item.status === "attention") return statusDot("warning", { label: "Needs attention" });
    return nothing;
  }

  private renderItem = (index: number) => {
    const item = this._items[index];
    if (!item) return nothing;
    const code = item.detailStyle === "code";
    return html`
      <div class="px-3 py-2 flex items-center gap-3 text-left">
        <reins-view-mount class="block size-3.5 shrink-0 overflow-hidden text-zinc-400" aria-hidden="true" .presentation=${item.icon}></reins-view-mount>
        <div class="flex-1 min-w-0 flex items-baseline gap-2 text-sm">
          <span class="shrink-0 max-w-[60%] truncate font-medium text-zinc-200">${item.title}</span>
          ${item.detail
            ? html`<span class="min-w-0 truncate text-zinc-500 ${code ? "font-mono text-xs" : ""}">${item.detail}</span>`
            : nothing}
        </div>
        ${this.renderStatus(item)}
      </div>
    `;
  };

  override render() {
    if (!this._open) return nothing;
    const pending = this.store?.pending ?? false;

    return html`
      <div
        id="palette-backdrop"
        class="fixed inset-0 z-[var(--layer-palette)] flex items-center justify-center px-4 bg-black/70"
        @click=${this.handleBackdropClick}
      >
        <search-palette
          placeholder="Search sessions and commands..."
          .itemCount=${this._items.length}
          .loading=${pending && this._items.length === 0}
          emptyMessage="Nothing found"
          .renderItem=${this.renderItem}
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
    "app-launcher": Launcher;
  }
}
