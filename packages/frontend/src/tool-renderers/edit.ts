/**
 * Edit tool renderer.
 *
 * Card-style block (matching read-tool-block) with file path + stats badge.
 * When expanded, shows an inline diff using the server-computed unified diff
 * from details.diff (with context lines), falling back to a naive
 * oldText→newText diff when details aren't available.
 */

import { html } from "lit";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../chat-state.js";
import type { DiffLine } from "../models/changes/types.js";

// ---------------------------------------------------------------------------
// Pure logic helpers (tested without DOM)
// ---------------------------------------------------------------------------

/** Extract the file path from an Edit tool block's args. */
export function getEditSummary(block: ToolBlockData): string {
  return block.args?.path ?? "";
}

/** Compute addition/removal line counts. Prefers details.diff when available, falls back to oldText/newText. */
export function getEditStats(block: ToolBlockData): { additions: number; removals: number } {
  const diffStr = block.result?.details?.diff as string | undefined;
  if (diffStr) {
    const diffLines = parseDiffString(diffStr);
    return {
      additions: diffLines.filter((l) => l.type === "add").length,
      removals: diffLines.filter((l) => l.type === "remove").length,
    };
  }

  const oldText: string = block.args?.oldText ?? "";
  const newText: string = block.args?.newText ?? "";

  const removals = oldText ? oldText.split("\n").length : 0;
  const additions = newText ? newText.split("\n").length : 0;

  return { additions, removals };
}

/**
 * Compute a simple diff from oldText to newText.
 *
 * Current implementation: all old lines as "remove", all new lines as "add".
 * A smarter LCS-based diff can replace this later.
 */
export function computeEditDiff(oldText: string, newText: string): DiffLine[] {
  const lines: DiffLine[] = [];

  if (oldText) {
    const oldLines = oldText.split("\n");
    for (let i = 0; i < oldLines.length; i++) {
      lines.push({ type: "remove", text: oldLines[i], oldLine: i + 1 });
    }
  }

  if (newText) {
    const newLines = newText.split("\n");
    for (let i = 0; i < newLines.length; i++) {
      lines.push({ type: "add", text: newLines[i], newLine: i + 1 });
    }
  }

  return lines;
}

/**
 * Parse a pi SDK diff string into DiffLine[].
 *
 * The format is:
 *   +<lineNum> <text>   — added line
 *   -<lineNum> <text>   — removed line
 *    <lineNum> <text>   — context line
 *    <spaces>  ...      — ellipsis (skipped context)
 *
 * Line numbers may be space-padded.
 */
export function parseDiffString(diff: string): DiffLine[] {
  if (!diff) return [];

  const lines: DiffLine[] = [];

  for (const raw of diff.split("\n")) {
    if (!raw) continue;

    // Ellipsis line: "    ..."
    if (/^\s+\.\.\./.test(raw)) {
      lines.push({ type: "context", text: "⋯", newLine: undefined });
      continue;
    }

    const prefix = raw[0];

    if (prefix === "+") {
      const match = raw.match(/^\+\s*(\d+) (.*)$/);
      if (match) {
        lines.push({ type: "add", text: match[2], newLine: parseInt(match[1], 10) });
      }
    } else if (prefix === "-") {
      const match = raw.match(/^-\s*(\d+) (.*)$/);
      if (match) {
        lines.push({ type: "remove", text: match[2], oldLine: parseInt(match[1], 10) });
      }
    } else if (prefix === " ") {
      const match = raw.match(/^ \s*(\d+) (.*)$/);
      if (match) {
        lines.push({ type: "context", text: match[2], newLine: parseInt(match[1], 10) });
      }
    }
  }

  return lines;
}

/**
 * Get the diff lines for rendering. Prefers details.diff (server-computed with
 * context lines), falls back to naive oldText→newText diff.
 */
export function getEditDiffLines(block: ToolBlockData): DiffLine[] {
  const diffStr = block.result?.details?.diff as string | undefined;
  if (diffStr) {
    return parseDiffString(diffStr);
  }
  return computeEditDiff(block.args?.oldText ?? "", block.args?.newText ?? "");
}

/** Threshold for auto-expanding small diffs inline (line count). */
export const AUTO_EXPAND_THRESHOLD = 20;

/**
 * Determine whether a diff should start expanded (auto-expand).
 *
 * Small diffs (≤ threshold lines) auto-expand; large diffs start collapsed.
 */
export function shouldAutoExpand(block: ToolBlockData): boolean {
  const diffLines = getEditDiffLines(block);
  if (diffLines.length === 0) return false;
  return diffLines.length <= AUTO_EXPAND_THRESHOLD;
}

/**
 * Determine whether the diff should be shown for an edit tool block.
 *
 * Uses the component's own `expanded` state (which may have been
 * initialised via `shouldAutoExpand`).
 */
export function shouldShowEditDiff(opts: {
  block: ToolBlockData;
  expanded: boolean;
  showSpinner?: boolean;
}): boolean {
  const { block, expanded, showSpinner } = opts;
  if (showSpinner || block.isError) return false;

  const diffLines = getEditDiffLines(block);
  if (diffLines.length === 0) return false;

  return expanded;
}

// ---------------------------------------------------------------------------
// Renderer — delegates visual output to <edit-tool-block> component
// ---------------------------------------------------------------------------

// Side-effect import: registers <edit-tool-block> custom element
import "./edit-tool-block.js";

function renderEditBlock(block: ToolBlockData, showSpinner: boolean) {
  const path = getEditSummary(block);
  const isError = !!block.isError;
  const { additions, removals } = getEditStats(block);
  const diffLines = getEditDiffLines(block);
  const autoExpand = !showSpinner && block.status === "done" && shouldAutoExpand(block);

  return html`<edit-tool-block
    .path=${path}
    .isError=${isError}
    .additions=${additions}
    .removals=${removals}
    .diffLines=${diffLines}
    .autoExpand=${autoExpand}
    .showSpinner=${showSpinner}
  ></edit-tool-block>`;
}

export const editRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    return renderEditBlock(block, block.status === "running");
  },
};
