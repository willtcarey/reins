/**
 * Read tool renderer.
 *
 * File-viewer style block: file path is always visible with a 📄 icon,
 * and a short content preview (first few lines) is shown inline.
 * Expanding reveals the full content below. Does NOT use the generic
 * `renderCollapsibleTool` helper — owns its full rendering surface.
 *
 * The visual rendering is handled by the `<read-tool-block>` Lit component
 * (./read-tool-block.ts) which adds lazy syntax highlighting via
 * IntersectionObserver + HighlightController.
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";
import type { ToolResultImage } from "./types.js";
// Side-effect import: registers <read-tool-block> custom element
import "./read-tool-block.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (tested without DOM)
// ---------------------------------------------------------------------------

/** Regex matching the trailing "[N more lines..." metadata line from the Read tool. */
const TRAILER_RE = /\n*\[(\d+ more lines in file\. Use offset=\d+ to continue.*)\]\s*$/;

/** Get the raw joined text from a Read tool block's result. */
function getRawText(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
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
  const offset = block.args?.offset as number | undefined;
  const limit = block.args?.limit as number | undefined;
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
function getReadImages(block: ToolBlockData): ToolResultImage[] {
  return (
    block.result?.content
      ?.filter(
        (c): c is { type: "image"; data: string; mimeType: string } =>
          c.type === "image",
      )
      .map((c) => ({ data: c.data, mimeType: c.mimeType })) ?? []
  );
}

// ---------------------------------------------------------------------------
// Preview line count — must match the component constant
// ---------------------------------------------------------------------------
const PREVIEW_LINES = 4;

// ---------------------------------------------------------------------------
// Renderer — delegates visual output to <read-tool-block> component
// ---------------------------------------------------------------------------

export const readRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const path = getReadSummary(block);
    const range = getReadRange(block);
    const trailer = isRunning ? "" : getReadTrailer(block);
    const preview = isRunning ? "" : getReadPreview(block, PREVIEW_LINES);
    const content = isRunning ? "" : getReadContent(block);
    const totalLines = isRunning ? 0 : getReadLineCount(block);
    const startLine = (block.args?.offset as number | undefined) ?? 1;
    const isError = !isRunning && !!block.isError;
    const images = isRunning ? [] : getReadImages(block);

    return html`<read-tool-block
      .path=${path}
      .range=${range}
      .trailer=${trailer}
      .preview=${preview}
      .content=${content}
      .totalLines=${totalLines}
      .startLine=${startLine}
      .isError=${isError}
      .images=${images}
      .showSpinner=${isRunning}
    ></read-tool-block>`;
  },
};
