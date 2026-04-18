/**
 * Skill Suggest
 *
 * Popover that lists available skills as the user types a `/name` token in a
 * chat textarea. The component reads the available skill list off a
 * `ProjectStore` and handles filtering, selection, and keyboard navigation.
 * The parent owns the textarea and is responsible for detecting the `/name`
 * token, calling `search()` with the partial name (or `null` to close), and
 * applying the text change when `skill-insert` fires.
 *
 * Usage:
 *   <div class="relative">
 *     <skill-suggest
 *       .store=${projectStore}
 *       @skill-insert=${handleInsert}
 *     ></skill-suggest>
 *     <textarea
 *       @input=${...}         // extract query from text, call skillSuggest.search(query)
 *       @keydown=${...}       // call skillSuggest.handleKey(e) first
 *       @blur=${...}          // call skillSuggest.close() after a short delay
 *     ></textarea>
 *   </div>
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { InjectedSkillInfo } from "../models/ws-client.js";
import { fuzzyMatch } from "../models/stores/quick-open-store.js";

export interface SkillInsertDetail {
  /** The name of the accepted skill (without the leading `/`). */
  name: string;
}

@customElement("skill-suggest")
export class SkillSuggest extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Project store whose `skills` field drives the suggestion list. */
  @property({ attribute: false })
  store: ProjectStore | null = null;

  @state() private open = false;
  @state() private suggestions: InjectedSkillInfo[] = [];
  @state() private selectedIndex = 0;

  /**
   * Update the suggestion list for the given partial skill name. Pass `null`
   * to close the popover (caret moved out of a `/name` token). An empty
   * string means the caret sits right after a `/` with no characters yet —
   * show every skill.
   */
  search(query: string | null) {
    if (query === null) { this.close(); return; }

    const skills = this.store?.skills ?? [];
    let matches: InjectedSkillInfo[];
    if (query === "") {
      matches = [...skills];
    } else {
      const lower = query.toLowerCase();
      const scored: Array<{ skill: InjectedSkillInfo; score: number }> = [];
      for (const skill of skills) {
        const score = fuzzyMatch(lower, skill.name);
        if (score !== null) scored.push({ skill, score });
      }
      scored.sort((a, b) => a.score - b.score);
      matches = scored.map((s) => s.skill);
    }
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
   * dispatching a `skill-insert` event. The parent is responsible for
   * applying the text change and restoring caret/focus.
   */
  private accept(index?: number) {
    const picked = this.suggestions[index ?? this.selectedIndex];
    if (!picked) return;

    this.close();

    this.dispatchEvent(
      new CustomEvent<SkillInsertDetail>("skill-insert", {
        bubbles: true,
        composed: true,
        detail: { name: picked.name },
      }),
    );
  }

  override updated(changed: PropertyValues) {
    if (!this.open) return;
    if (!changed.has("selectedIndex") && !changed.has("suggestions")) return;
    const root = this.renderRoot as HTMLElement;
    const item = root.querySelector<HTMLElement>(
      `[data-index="${this.selectedIndex}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
  }

  override render() {
    if (!this.open || this.suggestions.length === 0) return nothing;
    return html`
      <div class="absolute left-0 right-0 bottom-[calc(100%+0.5rem)] z-20 bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden shadow-2xl shadow-black/60 origin-bottom animate-[skill-popover-in_120ms_ease-out]">
        <div class="px-3 py-1 bg-blue-500/10 border-b border-blue-500/30 text-[10px] uppercase tracking-wide text-blue-300/80 font-semibold">
          Skills
        </div>
        <div class="max-h-60 overflow-y-auto">
          ${this.suggestions.map((s, i) => {
            const selected = i === this.selectedIndex;
            return html`
              <button
                data-index=${i}
                class="flex flex-col w-full items-start gap-0.5 text-left px-3 py-1.5 text-sm border-l-2 cursor-pointer ${selected ? "bg-zinc-800 border-blue-400" : "border-transparent hover:bg-zinc-800/60"}"
                @mousedown=${(e: Event) => { e.preventDefault(); this.accept(i); }}
                @mouseenter=${() => { this.selectedIndex = i; }}
              >
                <span class="font-mono text-zinc-100">/${s.name}</span>
                ${s.description ? html`<span class="text-xs text-zinc-400 leading-tight">${s.description}</span>` : nothing}
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
    "skill-suggest": SkillSuggest;
  }
}
