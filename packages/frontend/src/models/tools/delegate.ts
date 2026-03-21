/**
 * Pure logic helpers for delegate tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";

/** Extract a truncated prompt summary (first ~80 chars) from a delegate tool block. */
export function getDelegateSummary(block: ToolBlockData, maxLen = 80): string {
  const prompt = block.args?.prompt;
  if (!prompt || typeof prompt !== "string") return "";
  if (prompt.length <= maxLen) return prompt;
  return prompt.slice(0, maxLen) + "…";
}

/** Extract the full prompt text from a delegate tool block. */
export function getDelegateDetail(block: ToolBlockData): { prompt: string } {
  return {
    prompt: block.args?.prompt ?? "",
  };
}

/** Extract the delegate result text from a delegate tool block. */
export function getDelegateResult(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}
