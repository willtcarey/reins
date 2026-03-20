/**
 * create_task tool renderer.
 *
 * Shows task title + branch when collapsed,
 * description when expanded.
 */

import { html, nothing } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";
import { renderRunningTool, renderCollapsibleTool } from "./base.js";

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
// Renderer
// ---------------------------------------------------------------------------

export const createTaskRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const title = getTaskSummary(block);
    return renderRunningTool({
      name: "create_task",
      summary: title ? html`<span>📋 ${title} — creating task…</span>` : "creating task…",
    });
  },

  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void) {
    const title = getTaskSummary(block);
    const { description, branch } = getTaskDetail(block);

    const summary = html`${title
      ? html`<span class="text-zinc-400">📋 ${title}</span>`
      : nothing}${branch
      ? html`<span class="text-zinc-600 ml-2 font-mono">${branch}</span>`
      : nothing}`;

    const detail = html`
      <div class="mt-1 text-xs">
        ${description
          ? html`<div class="text-zinc-300 mb-1">${description}</div>`
          : nothing}
        ${branch
          ? html`<div class="text-zinc-500 font-mono">branch: ${branch}</div>`
          : nothing}
      </div>
    `;

    return renderCollapsibleTool({
      block,
      expanded,
      onToggle,
      summary,
      detail,
      isError: block.isError,
    });
  },
};
