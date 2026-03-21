/**
 * create_task tool renderer.
 *
 * Card-style layout that visually distinguishes task creation from
 * regular tool calls. Shows task title + branch when collapsed,
 * description when expanded.
 *
 * Owns its full rendering surface (does NOT use the generic
 * `renderCollapsibleTool` helper).
 */

import { html, nothing } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (tested without DOM)
// ---------------------------------------------------------------------------

/** Extract the task title from a create_task tool block's args. */
export function getTaskSummary(block: ToolBlockData): string {
  return block.args?.title ?? "";
}

/** Extract description and branch from a create_task tool block's args. */
export function getTaskDetail(block: ToolBlockData): { description: string; branch: string } {
  return {
    description: block.args?.description ?? "",
    branch: block.args?.branch_name ?? "",
  };
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

function renderTaskCard(opts: {
  title: string;
  description: string;
  branch: string;
  isRunning?: boolean;
  isError?: boolean;
  expanded?: boolean;
  resultText?: string;
  onToggle?: () => void;
}) {
  const borderColor = opts.isError
    ? "border-emerald-500/60"
    : opts.isRunning
      ? "border-emerald-400/60"
      : "border-emerald-600/40";

  const clickable = !opts.isRunning;

  return html`
    <div
      class="mt-1 mb-1 ml-2 rounded-lg border ${borderColor} bg-zinc-950/80 overflow-hidden ${clickable ? "cursor-pointer" : ""}"
      @click=${clickable ? opts.onToggle : nothing}
    >
      <!-- Header -->
      <div class="px-3 py-2 flex items-center gap-2 bg-emerald-500/5">
        ${opts.isRunning
          ? html`<span class="inline-block w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
          : html`<span class="text-xs flex-shrink-0">${opts.expanded ? "▼" : "▶"}</span>`}
        <span class="flex-shrink-0">📋</span>
        <span class="text-xs font-semibold text-emerald-300 flex-shrink-0">create_task</span>
        <span class="text-xs text-zinc-300 truncate">${opts.title || "Untitled task"}</span>
        ${opts.isError
          ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
          : nothing}
        ${opts.isRunning
          ? html`<span class="text-[10px] text-emerald-400/70 flex-shrink-0">creating…</span>`
          : nothing}
      </div>

      <!-- Branch (always visible when present) -->
      ${opts.branch ? html`
        <div class="px-3 py-1.5 border-t border-emerald-500/10">
          <span class="text-[10px] font-mono text-emerald-500/70">${opts.branch}</span>
        </div>
      ` : nothing}

      <!-- Description (only when expanded) -->
      ${opts.expanded && opts.description ? html`
        <div class="px-3 pb-2 border-t border-emerald-500/10">
          <pre class="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words m-0 mt-2">${opts.description}</pre>
        </div>
      ` : nothing}

      <!-- Result (only when expanded and available) -->
      ${opts.expanded && opts.resultText ? html`
        <div class="border-t border-emerald-500/10">
          <div class="px-3 pt-2 pb-1">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/60">Result</span>
          </div>
          <pre class="px-3 pb-2 text-xs font-mono ${opts.isError ? "text-red-400" : "text-zinc-400"} whitespace-pre-wrap break-words m-0 max-h-64 overflow-y-auto">${opts.resultText.slice(0, 5000)}</pre>
        </div>
      ` : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export const createTaskRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const title = getTaskSummary(block);
    const { description, branch } = getTaskDetail(block);

    return renderTaskCard({
      title,
      description,
      branch,
      isRunning: true,
    });
  },

  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void) {
    const title = getTaskSummary(block);
    const { description, branch } = getTaskDetail(block);

    const resultText = block.result?.content
      ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n") ?? "";

    return renderTaskCard({
      title,
      description,
      branch,
      isError: block.isError,
      expanded,
      resultText,
      onToggle,
    });
  },
};
