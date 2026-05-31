/**
 * Pure logic helpers for Read tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";
import { isImageAttachmentBlock, isInlineImageBlock } from "../chat-content.js";
import type { ToolResultImage } from "./types.js";

/** Regex matching the trailing "[N more lines..." metadata line from the Read tool. */
const TRAILER_RE = /\n*\[(\d+ more lines in file\. Use offset=\d+ to continue.*)\]\s*$/;

/** Number of preview lines to show when collapsed. */
export const PREVIEW_LINES = 4;

/** Strip `cat -n` line-number prefixes (e.g. "     1\t") from each line. */
function stripLineNumbers(text: string): string {
  return text.replace(/^\s*\d+\t/gm, "");
}

/** Get the joined text from a Read tool block's result, with `cat -n` prefixes stripped. */
function getRawText(block: ToolBlockData): string {
  const joined = block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
  return stripLineNumbers(joined);
}

/** Strip the trailing metadata line (e.g. "[163 more lines...]") from result text. */
function stripTrailer(text: string): string {
  return text.replace(TRAILER_RE, "");
}

/** Extract the file path from a Read tool block's args. */
export function getReadSummary(block: ToolBlockData): string {
  return block.args?.path ?? "";
}

/** Extract the offset/limit range label, if offset or limit were specified. */
export function getReadRange(block: ToolBlockData): string {
  const offset: number | undefined = typeof block.args?.offset === "number" ? block.args.offset : undefined;
  const limit: number | undefined = typeof block.args?.limit === "number" ? block.args.limit : undefined;
  if (!offset && !limit) return "";
  if (offset && limit) return `L${offset}–${offset + limit - 1}`;
  if (offset) return `L${offset}+`;
  return `${limit} lines`;
}

/** Extract the trailing metadata line if present (without brackets). */
export function getReadTrailer(block: ToolBlockData): string {
  const raw = getRawText(block);
  const match = raw.match(TRAILER_RE);
  return match ? match[1] : "";
}

/** Extract first N lines of result text as a preview string. Long lines are truncated. */
export function getReadPreview(block: ToolBlockData, maxLines = 2): string {
  const raw = getRawText(block);
  const cleaned = stripTrailer(raw);
  if (!cleaned) return "";

  const lines = cleaned.split("\n").slice(0, maxLines);
  const maxLineLen = 200;
  return lines
    .map((line) => (line.length > maxLineLen ? line.slice(0, maxLineLen) + "…" : line))
    .join("\n");
}

/** Get the full content text from a Read tool block (trailer stripped), truncated to limit. */
export function getReadContent(block: ToolBlockData, maxLen = 5000): string {
  const raw = getRawText(block);
  return stripTrailer(raw).slice(0, maxLen);
}

/** Count total lines in the full result text (trailer stripped). */
export function getReadLineCount(block: ToolBlockData): number {
  const raw = getRawText(block);
  const cleaned = stripTrailer(raw);
  if (!cleaned) return 0;
  return cleaned.split("\n").length;
}

/** Extract image content blocks from a Read tool block's result. */
export function getReadImages(block: ToolBlockData): ToolResultImage[] {
  return block.result?.content
    ?.filter((c): c is ToolResultImage => isInlineImageBlock(c) || isImageAttachmentBlock(c)) ?? [];
}
