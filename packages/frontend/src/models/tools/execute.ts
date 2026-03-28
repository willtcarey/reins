/**
 * Pure logic helpers for Execute tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";

/** Extract the JS code string from an Execute tool block. */
export function getExecuteCode(block: ToolBlockData): string {
  return block.args?.code ?? "";
}

/** Get a compact preview of the code (first line, truncated). */
export function getExecuteCodePreview(block: ToolBlockData, maxLen = 120): string {
  const code = getExecuteCode(block);
  if (!code) return "";
  const firstLine = code.split("\n")[0];
  if (firstLine.length > maxLen) {
    return firstLine.slice(0, maxLen - 1) + "…";
  }
  return firstLine;
}

/** Get the full output text from an Execute tool block. */
export function getExecuteOutput(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

/** Get error/status info from an Execute tool block. */
export function getExecuteExitInfo(block: ToolBlockData): { isError: boolean; label: string } {
  if (block.status === "running") {
    return { isError: false, label: "running" };
  }
  if (block.isError) {
    return { isError: true, label: "error" };
  }
  return { isError: false, label: "ok" };
}
