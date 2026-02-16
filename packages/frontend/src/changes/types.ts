/**
 * Shared types for the changes/diff components.
 * Mirrors the backend diff API response shape.
 */

export interface DiffLine {
  type: "context" | "add" | "remove";
  html: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  additions: number;
  removals: number;
  hunks: DiffHunk[];
}
