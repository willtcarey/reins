/**
 * Popover that suggests commands and skills as the user types a `/name` token in a chat textarea.
 * The parent owns the textarea: it finds the token, calls `search()` with its partial name (or `null`
 * to close) and whether it starts the message, and applies the text change when `slash-insert` fires.
 *
 * Usage:
 *   <div class="relative">
 *     <slash-suggest
 *       .store=${projectStore}
 *       .commands=${commands}
 *       .session=${{ sessionId, running }}
 *       @slash-insert=${handleInsert}
 *     ></slash-suggest>
 *     <textarea
 *       @input=${...}         // extract the token, call slashSuggest.search(query, atStart)
 *       @keydown=${...}       // call slashSuggest.handleKey(e) first
 *       @blur=${...}          // call slashSuggest.close() after a short delay
 *     ></textarea>
 *   </div>
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CommandSession } from "@reins/sdk";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { CommandRegistry } from "../sdk-host/commands.js";
import { slashSuggestions, type SlashSuggestion } from "../models/slash-suggestions.js";
import { slashInsertEvent } from "./events.js";

const SECTION_LABELS: Record<SlashSuggestion["kind"], string> = { command: "Commands", skill: "Skills" };

@customElement("slash-suggest")
export class SlashSuggest extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Project store whose `skills` field gives the skills suggested. */
  @property({ attribute: false })
  store: ProjectStore | null = null;

  @property({ attribute: false })
  commands: CommandRegistry | null = null;

  /** The session typed in, which says whether each command can run now. */
  @property({ attribute: false })
  session: CommandSession = { sessionId: "", running: false };

  @state() private open = false;
  @state() private suggestions: SlashSuggestion[] = [];
  @state() private selectedIndex = 0;

  /**
   * Update the suggestions for the given partial name. Pass `null` to close the popover (caret moved
   * out of a `/name` token). An empty string means the caret sits right after a `/` with no characters
   * yet: suggest everything. Commands are suggested only when the token starts the message.
   */
  search(query: string | null, atStart = false) {
    if (query === null) { this.close(); return; }

    const matches = slashSuggestions(query, {
      commands: this.commands?.list() ?? [],
      skills: this.store?.skills ?? [],
      atStart,
      session: this.session,
    });
    if (matches.length === 0) { this.close(); return; }

    this.suggestions = matches;
    if (this.selectedIndex >= matches.length) this.selectedIndex = 0;
    this.open = true;
  }

  /**
   * Intercept a textarea keydown. Returns `true` if the key was handled by
   * the suggestion popover and the parent should not process it further.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open || this.suggestions.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex =
        (this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length;
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      this.accept();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return true;
    }
    return false;
  }

  /** Close the popover and reset its state. */
  close() {
    if (!this.open && this.suggestions.length === 0) return;
    this.open = false;
    this.suggestions = [];
    this.selectedIndex = 0;
  }

  /**
   * Accept the suggestion at `index` (defaults to the current selection) by
   * dispatching a `slash-insert` event. The parent is responsible for
   * applying the text change and restoring caret/focus.
   */
  private accept(index?: number) {
    const picked = this.suggestions[index ?? this.selectedIndex];
    if (!picked) return;

    this.close();

    this.dispatchEvent(slashInsertEvent(picked.name));
  }

  override updated(changed: PropertyValues) {
    if (!this.open) return;
    if (!changed.has("selectedIndex") && !changed.has("suggestions")) return;
    const root = this.renderRoot;
    if (!(root instanceof HTMLElement)) return;
    const item = root.querySelector<HTMLElement>(
      `[data-index="${this.selectedIndex}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
  }

  private renderSuggestion(suggestion: SlashSuggestion, index: number) {
    const selected = index === this.selectedIndex;
    const header = this.suggestions[index - 1]?.kind !== suggestion.kind ? html`
      <div class="px-3 py-1 bg-blue-500/10 border-y border-blue-500/30 first:border-t-0 text-[10px] uppercase tracking-wide text-blue-300/80 font-semibold">
        ${SECTION_LABELS[suggestion.kind]}
      </div>
    ` : nothing;
    return html`
      ${header}
      <button
        data-index=${index}
        class="flex flex-col w-full items-start gap-0.5 text-left px-3 py-1.5 text-sm border-l-2 cursor-pointer ${selected ? "bg-zinc-800 border-blue-400" : "border-transparent hover:bg-zinc-800/60"}"
        @mousedown=${(e: Event) => { e.preventDefault(); this.accept(index); }}
        @mouseenter=${() => { this.selectedIndex = index; }}
      >
        <span class="font-mono ${suggestion.unavailable ? "text-zinc-500" : "text-zinc-100"}">/${suggestion.name}</span>
        ${suggestion.description ? html`<span class="text-xs text-zinc-400 leading-tight">${suggestion.description}</span>` : nothing}
        ${suggestion.unavailable ? html`<span class="text-xs text-amber-400/80 leading-tight">${suggestion.unavailable}</span>` : nothing}
      </button>
    `;
  }

  override render() {
    if (!this.open || this.suggestions.length === 0) return nothing;
    return html`
      <div class="absolute left-0 right-0 bottom-[calc(100%+0.5rem)] z-20 bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden shadow-2xl shadow-black/60 origin-bottom animate-[slash-popover-in_120ms_ease-out]">
        <div class="max-h-60 overflow-y-auto">
          ${this.suggestions.map((suggestion, index) => this.renderSuggestion(suggestion, index))}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "slash-suggest": SlashSuggest;
  }
}
