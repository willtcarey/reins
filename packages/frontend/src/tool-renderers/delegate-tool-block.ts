/**
 * DelegateToolBlock — Lit component for rendering delegate tool calls.
 *
 * Pure presentational component. Card-style layout with purple accent.
 * Shows truncated prompt when collapsed, full prompt + result when expanded.
 *
 * All data is passed as primitive props by the renderer (delegate.ts).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("delegate-tool-block")
export class DelegateToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Truncated prompt summary (~80 chars). */
  @property({ attribute: false })
  summary = "";

  /** Full prompt text. */
  @property({ attribute: false })
  prompt = "";

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
      ? "border-purple-500/60"
      : this.showSpinner
        ? "border-purple-400/60"
        : "border-purple-600/40";

    const displaySummary = this.showSpinner
      ? (this.summary || "delegating…")
      : (this.summary || "delegate");

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg border ${borderColor} bg-zinc-950/80 overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Header -->
        <div class="px-3 py-2 flex items-center gap-2 bg-purple-500/5">
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="text-xs flex-shrink-0">${this.expanded ? "▼" : "▶"}</span>`}
          <span class="text-purple-400 flex-shrink-0">⑂</span>
          <span class="text-xs font-semibold text-purple-300 flex-shrink-0">delegate</span>
          ${this.isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${this.showSpinner
            ? html`<span class="text-[10px] text-purple-400/70 flex-shrink-0">running…</span>`
            : nothing}
        </div>

        <!-- Prompt summary (always visible) -->
        <div class="px-3 py-2 border-t border-purple-500/10">
          <pre class="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words m-0 ${this.expanded ? "" : "line-clamp-2"}">${this.expanded ? this.prompt : displaySummary}</pre>
        </div>

        <!-- Result (only when expanded and available) -->
        ${this.expanded && this.resultText ? html`
          <div class="border-t border-purple-500/10">
            <div class="px-3 pt-2 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-purple-400/60">Result</span>
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
    "delegate-tool-block": DelegateToolBlock;
  }
}
