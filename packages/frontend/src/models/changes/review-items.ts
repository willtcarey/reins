import { parsePatchFiles, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs";
import { compareFilePaths } from "./diff-sort.js";

export interface ReviewItem {
  readonly id: string;
  readonly kind: "diff";
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: ChangeTypes;
  readonly additions: number;
  readonly removals: number;
  readonly occurrence: number;
  readonly contentKey: string;
  readonly cacheKey: string;
  readonly fileDiff: FileDiffMetadata;
}

export interface ReviewItemsResult {
  readonly items: ReviewItem[];
  readonly pathToItemId: Map<string, string>;
  readonly parseError: string | null;
}

/** Preserve object identity for files whose parsed diff content did not change. */
export function reconcileReviewItems(
  previous: ReviewItemsResult | null,
  next: ReviewItemsResult,
): ReviewItemsResult {
  if (!previous || next.parseError) return next;

  const previousById = new Map(previous.items.map((item) => [item.id, item]));
  const items = next.items.map((item) => {
    const candidate = previousById.get(item.id);
    return candidate?.contentKey === item.contentKey ? candidate : item;
  });
  return { ...next, items };
}

/**
 * Converts a complete raw patch into renderer-owned records. The records are
 * independent from DiffStore.fullData so a later virtual list can change only
 * the mounting strategy.
 */
export function parseReviewItems(
  patch: string,
  cacheKeyPrefix: string,
): ReviewItemsResult {
  try {
    const parsedPatches = parsePatchFiles(patch, undefined, true);
    const occurrences = new Map<string, number>();
    const items: ReviewItem[] = [];

    for (const parsedPatch of parsedPatches) {
      for (const parsedFileDiff of parsedPatch.files) {
        const path = parsedFileDiff.name;
        const oldPath = parsedFileDiff.prevName ?? null;
        const status = parsedFileDiff.type;
        const occurrenceKey = reviewItemIdentity(status, oldPath, path);
        const occurrence = occurrences.get(occurrenceKey) ?? 0;
        occurrences.set(occurrenceKey, occurrence + 1);
        const identity = `${occurrenceKey}:${occurrence}`;
        const contentKey = JSON.stringify(parsedFileDiff, (key, value) => key === "cacheKey" ? undefined : value);
        const cacheKey = `${cacheKeyPrefix}:${identity}`;
        const fileDiff = { ...parsedFileDiff, cacheKey };
        const additions = fileDiff.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
        const removals = fileDiff.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);

        items.push({
          id: `review:${identity}`,
          kind: "diff",
          path,
          oldPath,
          status,
          additions,
          removals,
          occurrence,
          contentKey,
          cacheKey,
          fileDiff,
        });
      }
    }

    items.sort((a, b) => compareFilePaths(a.path, b.path));
    const pathToItemId = new Map<string, string>();
    for (const item of items) {
      if (!pathToItemId.has(item.path)) pathToItemId.set(item.path, item.id);
      if (item.oldPath && !pathToItemId.has(item.oldPath)) pathToItemId.set(item.oldPath, item.id);
    }

    return { items, pathToItemId, parseError: null };
  } catch (error) {
    return {
      items: [],
      pathToItemId: new Map(),
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function reviewItemIdentity(status: ChangeTypes, oldPath: string | null, path: string): string {
  return `${status}:${oldPath ? encodeURIComponent(oldPath) : ""}:${encodeURIComponent(path)}`;
}
