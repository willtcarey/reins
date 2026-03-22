/**
 * Pure logic helpers for Write tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";

/** Extract the file path from a Write tool block's args. */
export function getWriteSummary(block: ToolBlockData): string {
  return block.args?.path ?? "";
}

/** Get line count of content being written. */
export function getWriteInfo(block: ToolBlockData): { lines: number } {
  const content = block.args?.content;
  if (!content || typeof content !== "string") return { lines: 0 };
  if (content === "") return { lines: 0 };
  return { lines: content.split("\n").length };
}

/** Extract and optionally truncate the content from a Write tool block. */
export function getWriteContent(block: ToolBlockData): string {
  const content = block.args?.content;
  if (!content || typeof content !== "string") return "";
  return content.length > 5000 ? content.slice(0, 5000) + "\n…(truncated)" : content;
}
