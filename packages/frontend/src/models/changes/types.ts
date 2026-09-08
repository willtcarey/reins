/** Shared changed-file and tool diff types. */

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
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
