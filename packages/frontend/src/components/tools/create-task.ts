/**
 * CreateTaskToolBlock — Lit component for rendering create_task tool calls.
 *
 * Pure presentational component. Card-style layout with emerald accent.
 * Shows task title + branch when collapsed, description + result when expanded.
 *
 * All data is received as primitive props — this component has no knowledge
 * of ToolBlockData or any extraction helpers.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { getTaskSummary, getTaskDetail, getResultText } from "../../models/tools/create-task.js";

@customElement("create-task-tool-block")
export class CreateTaskToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  title = "";

  @property({ attribute: false })
  description = "";

  @property({ attribute: false })
  branch = "";

  @property({ type: Boolean })
  isError = false;

  @property({ attribute: false })
  resultText = "";

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
      ? "border-emerald-500/60"
      : this.showSpinner
        ? "border-emerald-400/60"
        : "border-emerald-600/40";

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg border ${borderColor} bg-zinc-950/80 overflow-hidden ${clickable ? "cursor-pointer" : ""}"
        @click=${clickable ? this._toggle : nothing}
      >
        <!-- Header -->
        <div class="px-3 py-2 flex items-center gap-2 bg-emerald-500/5">
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="text-xs flex-shrink-0">${this.expanded ? "▼" : "▶"}</span>`}
          <span class="flex-shrink-0">📋</span>
          <span class="text-xs font-semibold text-emerald-300 flex-shrink-0">create_task</span>
          <span class="text-xs text-zinc-300 truncate">${this.title || "Untitled task"}</span>
          ${this.isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${this.showSpinner
            ? html`<span class="text-[10px] text-emerald-400/70 flex-shrink-0">creating…</span>`
            : nothing}
        </div>

        <!-- Branch (always visible when present) -->
        ${this.branch ? html`
          <div class="px-3 py-1.5 border-t border-emerald-500/10">
            <span class="text-[10px] font-mono text-emerald-500/70">${this.branch}</span>
          </div>
        ` : nothing}

        <!-- Description (only when expanded) -->
        ${this.expanded && this.description ? html`
          <div class="px-3 pb-2 border-t border-emerald-500/10">
            <pre class="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words m-0 mt-2">${this.description}</pre>
          </div>
        ` : nothing}

        <!-- Result (only when expanded and available) -->
        ${this.expanded && this.resultText ? html`
          <div class="border-t border-emerald-500/10">
            <div class="px-3 pt-2 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/60">Result</span>
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
    "create-task-tool-block": CreateTaskToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <create-task-tool-block>
// ---------------------------------------------------------------------------

export const createTaskRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const title = getTaskSummary(block);
    const { description, branch } = getTaskDetail(block);
    const isError = !isRunning && !!block.isError;
    const resultText = isRunning ? "" : getResultText(block);
    return html`<create-task-tool-block
      .title=${title}
      .description=${description}
      .branch=${branch}
      .isError=${isError}
      .resultText=${resultText}
      .showSpinner=${isRunning}
    ></create-task-tool-block>`;
  },
};
