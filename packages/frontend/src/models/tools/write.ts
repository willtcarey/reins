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

/**
 * The end of the content while it is still being written, at most `maxChars` from a line start, and the line
 * it starts on: the newest lines are what changes, and a long file is not rendered again whole each frame.
 */
export function getWriteTail(block: ToolBlockData, maxChars = 5000): { content: string; startLine: number } {
  const content = block.args?.content;
  if (!content || typeof content !== "string") return { content: "", startLine: 1 };
  if (content.length <= maxChars) return { content, startLine: 1 };
  const cut = content.indexOf("\n", content.length - maxChars);
  if (cut === -1) return { content: content.slice(-maxChars), startLine: content.split("\n").length };
  return { content: content.slice(cut + 1), startLine: content.slice(0, cut + 1).split("\n").length };
}

