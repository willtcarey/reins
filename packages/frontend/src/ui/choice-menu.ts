/**
 * A list to choose one item from, filtered by what is typed in its search field: the content of a
 * `popover-menu`, which it closes once an item is chosen.
 */

import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { fuzzyMatch } from "../helpers/fuzzy-match.js";
import type { PopoverMenu } from "./popover-menu.js";

export interface Choice {
  /** Null for the choice of none, such as no task. */
  id: number | null;
  label: string;
  /** A second line, which the query matches too. */
  detail?: string;
}

/** Every item for an empty query; otherwise those whose label or detail fuzzy-matches it, best first. */
export function matchingChoices(search: string, items: readonly Choice[]): Choice[] {
  if (!search) return [...items];
  const lower = search.toLowerCase();
  return items
    .map((item) => {
      const scores = [fuzzyMatch(lower, item.label), item.detail ? fuzzyMatch(lower, item.detail) : null].filter((score) => score !== null);
      return { item, score: scores.length > 0 ? Math.min(...scores) : null };
    })
    .filter((scored): scored is { item: Choice; score: number } => scored.score !== null)
    .toSorted((a, b) => a.score - b.score)
    .map((scored) => scored.item);
}

@customElement("choice-menu")
export class ChoiceMenu extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) items: readonly Choice[] = [];
  @property({ attribute: false }) selected: number | null = null;
  @property({ attribute: false }) choose: ((id: number | null) => void) | null = null;
  @property({ type: String }) placeholder = "Search…";
  @property({ type: String }) emptyMessage = "Nothing matches";

  @state() private search = "";
  @state() private activeIndex = 0;

  @query("input") private input?: HTMLInputElement;

  private get shownItems(): Choice[] {
    return matchingChoices(this.search, this.items);
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("items") || changed.has("selected")) this.activeIndex = Math.max(0, this.shownItems.findIndex((item) => item.id === this.selected));
  }

  override firstUpdated() {
    // The popover shows its panel after this render; focus only works once it is shown.
    requestAnimationFrame(() => this.input?.focus());
  }

  override updated(changed: PropertyValues) {
    if (changed.has("activeIndex")) this.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }

  private handleInput(e: { target: EventTarget | { value: string } | null }) {
    const target = e.target;
    if (!target || !("value" in target) || typeof target.value !== "string") return;
    this.search = target.value;
    this.activeIndex = 0;
  }

  private handleKeyDown(e: { key: string; preventDefault(): void }) {
    const count = this.shownItems.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (count > 0) this.activeIndex = (this.activeIndex + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = this.shownItems[this.activeIndex];
      if (item) this.pick(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.closePopover();
    }
  }

  private pick(item: Choice) {
    this.choose?.(item.id);
    this.closePopover();
  }

  private closePopover() {
    this.closest<PopoverMenu>("popover-menu")?.close();
  }

  override render() {
    const shown = this.shownItems;
    return html`
      <div class="flex max-h-[300px] flex-col">
        <div class="shrink-0 border-b border-zinc-700 p-1.5">
          <input
            class="w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:ring-1 focus:ring-blue-500/60"
            type="text"
            placeholder=${this.placeholder}
            aria-label=${this.placeholder}
            .value=${this.search}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
          />
        </div>
        <div class="min-h-0 overflow-y-auto py-1" role="listbox">
          ${shown.length === 0 ? html`<div class="px-3 py-1.5 text-xs text-zinc-500">${this.emptyMessage}</div>` : ""}
          ${shown.map((item, index) => {
            const active = index === this.activeIndex;
            const selected = item.id === this.selected;
            return html`
              <button
                type="button"
                role="option"
                aria-selected=${selected ? "true" : "false"}
                data-active=${active ? "true" : "false"}
                class="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer ${active ? "bg-zinc-700" : "hover:bg-zinc-700/60"} ${selected ? "text-zinc-100" : "text-zinc-300"}"
                @mouseenter=${() => { this.activeIndex = index; }}
                @click=${() => this.pick(item)}
              >
                <span class="mt-0.5 w-3 shrink-0 text-blue-300">${selected ? "✓" : ""}</span>
                <span class="min-w-0">
                  <span class="block truncate">${item.label}</span>
                  ${item.detail ? html`<span class="block truncate text-[11px] text-zinc-500">${item.detail}</span>` : ""}
                </span>
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "choice-menu": ChoiceMenu;
  }
}
