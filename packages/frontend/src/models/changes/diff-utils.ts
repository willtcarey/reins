/**
 * Pure utility functions extracted from diff-panel.ts.
 * These are stateless helpers used for rendering and computing diff layout.
 */

import type { DiffFile, DiffHunk } from "./types.js";

// ---- Constants -------------------------------------------------------------

/** Number of context lines to reveal per expand click. */
export const EXPAND_STEP = 15;

// ---- Path helpers ----------------------------------------------------------

/** Check whether a file path has a markdown extension (.md, .mdx, .markdown). */
export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

/** Image extensions renderable inline via `<img>`. */
const IMAGE_EXTS = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;

/** Check whether a file path is an image we can preview inline. */
export function isImage(path: string): boolean {
  return IMAGE_EXTS.test(path);
}

/** Check whether a file path is a PDF. */
export function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/**
 * Whether lines for this file should word-wrap instead of horizontal-scroll.
 * Currently wraps markdown files; extend this to add more prose-oriented
 * file types (e.g. .txt, .rst) in the future.
 */
export function shouldWrapLines(path: string): boolean {
  return isMarkdown(path);
}

/** Convert a file path to a valid HTML id for scroll targeting. */
export function fileCardId(path: string): string {
  return "diff-" + path.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ---- HTML helpers ----------------------------------------------------------

/** Escape HTML special characters so text can be safely inserted into markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- Diff layout helpers ---------------------------------------------------

/**
 * Compute the character width needed for the line-number gutter in a file.
 * Returns the number of `ch` units — at least 3.
 */
export function gutterWidth(file: DiffFile): number {
  let max = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine != null && line.newLine > max) max = line.newLine;
      if (line.oldLine != null && line.oldLine > max) max = line.oldLine;
    }
  }
  // Number of digits + 1 extra ch for breathing room
  return Math.max(3, String(max).length + 1);
}

/**
 * Find the last known line number in a hunk, scanning from the end.
 * Prefers newLine, falls back to oldLine, returns 0 if no lines have numbers.
 */
export function getHunkEndLine(hunk: DiffHunk): number {
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const line = hunk.lines[i];
    if (line.newLine != null) return line.newLine;
    if (line.oldLine != null) return line.oldLine;
  }
  return 0;
}
