/**
 * Shared types for the changes/diff components.
 * Mirrors the backend diff API response shapes.
 */

/** Lightweight file summary — returned by the polled /diff/files endpoint. */
export interface DiffFileSummary {
  path: string;
  additions: number;
  removals: number;
}

export interface DiffLine {
  type: "context" | "add" | "remove";
  /** Raw source text (no HTML). Highlighting is done client-side via Shiki. */
  text: string;
  /** Shiki-highlighted HTML, set asynchronously by the highlight worker. */
  html?: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** Parsed file diff — returned by the on-demand /diff endpoint. */
export interface DiffFile {
  path: string;
  additions: number;
  removals: number;
  hunks: DiffHunk[];
}
