/**
 * Branch Indicator
 *
 * Displays the currently checked-out git branch for the project,
 * sourced from the diff store's polling data. Shows the same branch
 * regardless of whether the active session is a task or scratch session —
 * it always reflects the actual working tree state.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("branch-indicator")
export class BranchIndicator extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The repo's current checked-out branch, provided by the diff store. */
  @property({ type: String }) currentBranch: string | null = null;

  override render() {
    if (!this.currentBranch) return nothing;

    return html`
      <div class="flex items-center gap-1.5 px-3 text-xs text-zinc-400 border-r border-zinc-700 self-stretch">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             class="shrink-0">
          <line x1="6" y1="3" x2="6" y2="15"></line>
          <circle cx="18" cy="6" r="3"></circle>
          <circle cx="6" cy="18" r="3"></circle>
          <path d="M18 9a9 9 0 0 1-9 9"></path>
        </svg>
        <span class="truncate max-w-[200px]">${this.currentBranch}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "branch-indicator": BranchIndicator;
  }
}
