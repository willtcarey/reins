/**
 * SearchToolBlock — Lit component for rendering search tool calls.
 *
 * Pure presentational component. Card-style layout with teal accent.
 * Shows query summary when collapsed with a result count badge,
 * full result text when expanded.
 *
 * All data is received as primitive props — this component has no knowledge
 * of ToolBlockData or any extraction helpers.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { getSearchSummary, getSearchQuery, getSearchResultText, getSearchResultCount } from "../../models/tools/search.js";

@customElement("search-tool-block")
export class SearchToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Truncated query summary (~80 chars). */
  @property({ attribute: false })
  summary = "";

  /** Full query string. */
  @property({ attribute: false })
  query = "";

  /** Number of results found. */
  @property({ type: Number })
  resultCount = 0;

  /** Whether the tool call resulted in an error. */
  @property({ type: Boolean })
  isError = false;

  /** Extracted text content from the result. */
  @property({ attribute: false })
  resultText = "";

  /** Whether to show the running spinner. */
  @property({ type: Boolean })
  showSpinner = false;

  @state()
  private expanded = false;

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  override render() {
    const clickable = !this.showSpinner;

    const borderColor = this.isError
      ? "border-red-500/60"
      : this.showSpinner
        ? "border-zinc-600"
        : "border-zinc-700";

    const displaySummary = this.showSpinner
      ? (this.summary || "searching…")
      : (this.summary || "search");

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg border ${borderColor} bg-zinc-900 overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Header -->
        <div class="px-3 py-2 flex items-center gap-2">
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <path d="M4 4 Q12 3 16 8 Q22 15 18 22" stroke="#f59e0b" stroke-width="2.5" fill="none" stroke-linecap="round"/>
                <path d="M4 9 Q11 8 14 12 Q20 19 18 24" stroke="#f59e0b" stroke-width="2.5" fill="none" stroke-linecap="round"/>
              </svg><span class="text-xs flex-shrink-0">🔍</span>`}
          <span class="text-xs font-mono text-zinc-300 truncate">${displaySummary}</span>
          ${this.isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${this.showSpinner
            ? html`<span class="text-[10px] text-zinc-500 flex-shrink-0">searching…</span>`
            : nothing}
          ${!this.showSpinner && !this.isError && this.resultCount > 0
            ? html`<span class="text-[10px] text-zinc-500 flex-shrink-0 ml-auto">${this.resultCount} result${this.resultCount === 1 ? "" : "s"}</span>`
            : nothing}
        </div>

        <!-- Result (only when expanded and available) -->
        ${this.expanded && this.resultText ? html`
          <div class="border-t border-zinc-800">
            <div class="px-3 pt-2 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Result</span>
            </div>
            <pre class="px-3 pb-2 text-xs font-mono ${this.isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">${this.resultText.slice(0, 5000)}</pre>
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "search-tool-block": SearchToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <search-tool-block>
// ---------------------------------------------------------------------------

export const searchRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const summary = getSearchSummary(block);
    const query = getSearchQuery(block);
    const isError = !isRunning && !!block.isError;
    const resultText = isRunning ? "" : getSearchResultText(block);
    const resultCount = isRunning ? 0 : getSearchResultCount(block);
    return html`<search-tool-block
      .summary=${summary}
      .query=${query}
      .resultCount=${resultCount}
      .isError=${isError}
      .resultText=${resultText}
      .showSpinner=${isRunning}
    ></search-tool-block>`;
  },
};
