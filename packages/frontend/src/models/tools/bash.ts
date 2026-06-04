/**
 * Pure logic helpers for Bash tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";
import { isImageAttachmentBlock, isInlineImageBlock } from "../chat-content.js";
import type { ChatImageBlock } from "../chat-content.js";

/** Extract the full command string from a Bash tool block. */
export function getBashCommand(block: ToolBlockData): string {
  return block.args?.command ?? "";
}

/** Extract the first line of output text for a compact preview. */
export function getBashPreview(block: ToolBlockData, maxLen = 120): string {
  const texts = block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text) ?? [];

  const joined = texts.join("\n").trim();
  if (!joined) return "";

  const firstLine = joined.split("\n")[0];
  if (firstLine.length > maxLen) {
    return firstLine.slice(0, maxLen - 1) + "…";
  }
  return firstLine;
}

/** Get the full output text from a Bash tool block. */
export function getBashOutput(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

/** Get exit/error info from a Bash tool block. */
export function getBashExitInfo(block: ToolBlockData): { isError: boolean; label: string } {
  if (block.status === "running") {
    return { isError: false, label: "running" };
  }
  if (block.isError) {
    return { isError: true, label: "error" };
  }
  return { isError: false, label: "ok" };
}

/** Extract image content items from a Bash tool block result. */
export function getBashImages(block: ToolBlockData): ChatImageBlock[] {
  return block.result?.content?.filter(
    (c): c is ChatImageBlock => isInlineImageBlock(c) || isImageAttachmentBlock(c),
  ) ?? [];
}
