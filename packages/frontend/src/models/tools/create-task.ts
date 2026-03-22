/**
 * Pure logic helpers for create_task tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";

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
