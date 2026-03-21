/**
 * create_task tool renderer.
 *
 * Card-style layout that visually distinguishes task creation from
 * regular tool calls. Shows task title + branch when collapsed,
 * description when expanded. Rendering is handled by the
 * `<create-task-tool-block>` Lit component (./create-task-tool-block.ts).
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";

// Side-effect import: registers <create-task-tool-block> custom element
import "./create-task-tool-block.js";

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

/** Extract the result text from a create_task tool block. */
export function getResultText(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

// ---------------------------------------------------------------------------
// Renderer — delegates visual output to <create-task-tool-block> component
// ---------------------------------------------------------------------------

export const createTaskRenderer: ToolRenderer = {
  renderRunning(block: ToolBlockData) {
    const title = getTaskSummary(block);
    const { description, branch } = getTaskDetail(block);
    return html`<create-task-tool-block
      .title=${title}
      .description=${description}
      .branch=${branch}
      .isError=${false}
      .resultText=${""}
      .showSpinner=${true}
    ></create-task-tool-block>`;
  },

  renderDone(block: ToolBlockData) {
    const title = getTaskSummary(block);
    const { description, branch } = getTaskDetail(block);
    const isError = !!block.isError;
    const resultText = getResultText(block);
    return html`<create-task-tool-block
      .title=${title}
      .description=${description}
      .branch=${branch}
      .isError=${isError}
      .resultText=${resultText}
      .showSpinner=${false}
    ></create-task-tool-block>`;
  },
};
