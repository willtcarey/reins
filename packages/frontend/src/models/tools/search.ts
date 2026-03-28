/**
 * Pure logic helpers for search tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";

/** Extract a truncated query summary (first ~80 chars) from a search tool block. */
export function getSearchSummary(block: ToolBlockData, maxLen = 80): string {
  const query = block.args?.query;
  if (!query || typeof query !== "string") return "";
  if (query.length <= maxLen) return query;
  return query.slice(0, maxLen) + "…";
}

/** Extract the full query string from a search tool block. */
export function getSearchQuery(block: ToolBlockData): string {
  return block.args?.query ?? "";
}

/** Extract the result text from a search tool block. */
export function getSearchResultText(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

/** Count the number of results (functions) found in the search output. */
export function getSearchResultCount(block: ToolBlockData): number {
  const text = getSearchResultText(block);
  if (!text) return 0;
  // Count function signatures — lines starting with "function " or containing common patterns
  // A simple heuristic: count lines that look like function headers
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    // Match common patterns in API function listings: "namespace.method(" or "function name("
    if (/^\w+\.\w+\s*\(/.test(trimmed) || /^function\s+\w+/.test(trimmed) || /^[-•]\s*\w+\.\w+/.test(trimmed)) {
      count++;
    }
  }
  // If heuristic found nothing, fall back to a rough count based on blank-line-separated blocks
  if (count === 0 && text.trim().length > 0) {
    const blocks = text.trim().split(/\n\n+/);
    return blocks.length;
  }
  return count;
}
