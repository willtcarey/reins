import { parsePatchFiles, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs";
import { compareFilePaths } from "./diff-sort.js";

export interface VirtualizedReviewItemState {
  collapsed: boolean;
  activeTab: "diff";
  parseError: string | null;
}

export interface VirtualizedReviewItem {
  id: string;
  kind: "diff";
  path: string;
  oldPath: string | null;
  status: ChangeTypes;
  occurrence: number;
  cacheKey: string;
  version: number;
  fileDiff: FileDiffMetadata;
  state: VirtualizedReviewItemState;
}

export interface VirtualizedReviewItemsResult {
  items: VirtualizedReviewItem[];
  pathToItemId: Map<string, string>;
  parseError: string | null;
}

/**
 * Converts a complete raw patch into renderer-owned records. The records are
 * independent from DiffStore.fullData so a later virtual list can change only
 * the mounting strategy.
 */
export function parseVirtualizedReviewItems(
  patch: string,
  cacheKeyPrefix: string,
  version: number,
): VirtualizedReviewItemsResult {
  try {
    const parsedPatches = parsePatchFiles(patch, undefined, true);
    const occurrences = new Map<string, number>();
    const items: VirtualizedReviewItem[] = [];

    for (const parsedPatch of parsedPatches) {
      for (const parsedFileDiff of parsedPatch.files) {
        const path = parsedFileDiff.name;
        const oldPath = parsedFileDiff.prevName ?? null;
        const status = parsedFileDiff.type;
        const occurrenceKey = reviewItemIdentity(status, oldPath, path);
        const occurrence = occurrences.get(occurrenceKey) ?? 0;
        occurrences.set(occurrenceKey, occurrence + 1);
        const identity = `${occurrenceKey}:${occurrence}`;
        const cacheKey = `${cacheKeyPrefix}:${identity}`;
        const fileDiff = { ...parsedFileDiff, cacheKey };

        items.push({
          id: `review:${identity}`,
          kind: "diff",
          path,
          oldPath,
          status,
          occurrence,
          cacheKey,
          version,
          fileDiff,
          state: {
            collapsed: false,
            activeTab: "diff",
            parseError: null,
          },
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
