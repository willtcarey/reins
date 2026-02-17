/**
 * Shared sort order for diff files.
 *
 * Sorts file paths using directory-first, alphabetical ordering at each level
 * — the same order used by the file tree.
 */

import type { DiffFile, DiffFileSummary } from "./types.js";

/**
 * Compare two file paths segment-by-segment using directory-first ordering.
 * At each level, directories sort before files; within each group,
 * names are compared alphabetically (locale-aware).
 */
function compareFilePaths(a: string, b: string): number {
  const partsA = a.split("/");
  const partsB = b.split("/");
  const len = Math.min(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const aIsLast = i === partsA.length - 1;
    const bIsLast = i === partsB.length - 1;

    // If one is a file (last segment) and the other is a directory, dir comes first
    if (aIsLast !== bIsLast) {
      return aIsLast ? 1 : -1;
    }

    // Same level type — compare names alphabetically
    const cmp = partsA[i].localeCompare(partsB[i]);
    if (cmp !== 0) return cmp;
  }

  // Shorter path (fewer segments) comes first if all segments matched
  return partsA.length - partsB.length;
}

/** Sort diff files in directory-first, alphabetical order (matching the file tree). */
export function sortDiffFiles(files: DiffFile[]): DiffFile[] {
  return [...files].sort((a, b) => compareFilePaths(a.path, b.path));
}

/** Sort file summaries in directory-first, alphabetical order. */
export function sortFileSummaries(files: DiffFileSummary[]): DiffFileSummary[] {
  return [...files].sort((a, b) => compareFilePaths(a.path, b.path));
}
