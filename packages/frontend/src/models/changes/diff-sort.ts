/** Directory-first, alphabetical ordering shared by changed-file surfaces. */

import type { DiffFileSummary } from "./types.js";

export function compareFilePaths(a: string, b: string): number {
  const partsA = a.split("/");
  const partsB = b.split("/");
  const len = Math.min(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const aIsLast = i === partsA.length - 1;
    const bIsLast = i === partsB.length - 1;

    if (aIsLast !== bIsLast) return aIsLast ? 1 : -1;

    const cmp = partsA[i].localeCompare(partsB[i]);
    if (cmp !== 0) return cmp;
  }

  return partsA.length - partsB.length;
}

export function sortFileSummaries(files: DiffFileSummary[]): DiffFileSummary[] {
  return files.toSorted((a, b) => compareFilePaths(a.path, b.path));
}
