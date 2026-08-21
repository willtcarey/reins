import {
  processFile,
  type FileContents,
  type FileDiffMetadata,
  type HunkExpansionRegion,
} from "@pierre/diffs";
import type { ReviewItem } from "./review-items.js";

export interface DiffContentSide {
  name: string;
  contents: string;
  contentId: string;
  blobId?: string;
}

export type DiffContentsResponse =
  | { status: "available"; oldFile?: DiffContentSide; newFile?: DiffContentSide }
  | { status: "unsupported"; reason: "binary" }
  | { status: "too_large"; limitBytes: number };

export interface ReviewExpansionScope {
  projectId: number;
  mode: "branch" | "uncommitted";
  branch?: string | null;
}

export type ReviewExpansionOutcome = "idle" | "loading" | "available" | "unsupported" | "error";

export type ReviewExpansionUnsupported =
  | { reason: "binary" }
  | { reason: "too_large"; limitBytes: number };

export interface ReviewExpansionSnapshot {
  readonly outcome: ReviewExpansionOutcome;
  /** The original partial metadata until complete contents are available. */
  readonly fileDiff: FileDiffMetadata;
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents | null;
  /** Opaque Pierre-owned regions retained only to restore a virtual remount. */
  readonly nativeExpandedHunks: ReadonlyMap<number, HunkExpansionRegion>;
  readonly unsupported: ReviewExpansionUnsupported | null;
  readonly error: string | null;
}

type FetchResponse = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Listener = () => void;

interface ItemEntry {
  snapshot: ReviewExpansionSnapshot;
  request: Promise<void> | null;
}

/**
 * Persistent state for lazy context expansion in the virtualized review path.
 * Its lifetime is intentionally independent of an individual mounted file.
 */
export class ReviewExpansionState {
  private readonly entries = new Map<string, ItemEntry>();
  private readonly contentCache = new Map<string, string>();
  private readonly fileCache = new Map<string, FileContents>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly scope: ReviewExpansionScope,
    private readonly fetchResponse: FetchResponse = (input, init) => fetch(input, init),
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  forItem(item: ReviewItem): ReviewExpansionSnapshot {
    return this.entryFor(item).snapshot;
  }

  /** Concurrent first native interactions share one complete-content request. */
  async acquire(item: ReviewItem): Promise<ReviewExpansionSnapshot> {
    const entry = this.entryFor(item);
    if (entry.snapshot.outcome === "idle") {
      this.update(entry, { ...entry.snapshot, outcome: "loading" });
      entry.request = this.load(item, entry);
    }
    if (entry.request) await entry.request;
    return entry.snapshot;
  }

  /** Retain Pierre's own expansion state without deriving or mutating regions. */
  retainNativeExpansion(
    item: ReviewItem,
    regions: ReadonlyMap<number, HunkExpansionRegion>,
  ): void {
    const entry = this.entryFor(item);
    const nativeExpandedHunks = new Map<number, HunkExpansionRegion>();
    for (const [index, region] of regions) nativeExpandedHunks.set(index, { ...region });
    entry.snapshot = { ...entry.snapshot, nativeExpandedHunks };
  }

  private entryFor(item: ReviewItem): ItemEntry {
    const key = `${item.id}\0${item.contentKey}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        snapshot: {
          outcome: "idle",
          fileDiff: item.fileDiff,
          oldFile: null,
          newFile: null,
          nativeExpandedHunks: new Map(),
          unsupported: null,
          error: null,
        },
        request: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async load(item: ReviewItem, entry: ItemEntry): Promise<void> {
    try {
      const response = await this.fetchResponse(this.contentsUrl(item));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result: DiffContentsResponse = await response.json();

      if (result.status === "unsupported") {
        this.update(entry, {
          ...entry.snapshot,
          outcome: "unsupported",
          unsupported: { reason: result.reason },
        });
        return;
      }
      if (result.status === "too_large") {
        this.update(entry, {
          ...entry.snapshot,
          outcome: "unsupported",
          unsupported: { reason: "too_large", limitBytes: result.limitBytes },
        });
        return;
      }
      if (result.status !== "available" || (!result.oldFile && !result.newFile)) {
        throw new Error("Complete file contents were unavailable");
      }

      const oldFile = result.oldFile
        ? this.fileContents(result.oldFile)
        : syntheticEmptyFile(item.oldPath ?? item.path, "old");
      const newFile = result.newFile
        ? this.fileContents(result.newFile)
        : syntheticEmptyFile(item.path, "new");
      const reconstructed = processFile(item.filePatch, {
        oldFile,
        newFile,
        cacheKey: `${oldFile.cacheKey}:${newFile.cacheKey}`,
        throwOnError: true,
      });
      if (!reconstructed) throw new Error("Complete diff reconstruction failed");
      if (!sameChangedLines(item.fileDiff, reconstructed)) {
        throw new Error("Complete contents no longer match the reviewed diff");
      }
      const fileDiff: FileDiffMetadata = {
        ...reconstructed,
        name: item.fileDiff.name,
        type: item.fileDiff.type,
        cacheKey: `${oldFile.cacheKey}:${newFile.cacheKey}`,
        ...(item.fileDiff.prevName ? { prevName: item.fileDiff.prevName } : {}),
        ...(item.fileDiff.lang ? { lang: item.fileDiff.lang } : {}),
        ...(item.fileDiff.newObjectId ? { newObjectId: item.fileDiff.newObjectId } : {}),
        ...(item.fileDiff.prevObjectId ? { prevObjectId: item.fileDiff.prevObjectId } : {}),
        ...(item.fileDiff.mode ? { mode: item.fileDiff.mode } : {}),
        ...(item.fileDiff.prevMode ? { prevMode: item.fileDiff.prevMode } : {}),
      };
      this.update(entry, {
        ...entry.snapshot,
        outcome: "available",
        fileDiff,
        oldFile,
        newFile,
      });
    } catch (error) {
      this.update(entry, {
        ...entry.snapshot,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      entry.request = null;
    }
  }

  private fileContents(side: DiffContentSide): FileContents {
    const identity = side.blobId ? `blob:${side.blobId}` : `content:${side.contentId}`;
    const cachedContents = this.contentCache.get(identity) ?? side.contents;
    this.contentCache.set(identity, cachedContents);
    const key = `${identity}\0${side.name}`;
    let file = this.fileCache.get(key);
    if (!file) {
      file = { name: side.name, contents: cachedContents, cacheKey: identity };
      this.fileCache.set(key, file);
    }
    return file;
  }

  private contentsUrl(item: ReviewItem): string {
    const params = new URLSearchParams({ mode: this.scope.mode });
    if (this.scope.branch) params.set("branch", this.scope.branch);
    if (item.oldPath || item.status !== "new") params.set("oldPath", item.oldPath ?? item.path);
    if (item.status !== "deleted") params.set("path", item.path);
    return `/api/projects/${this.scope.projectId}/diff/contents?${params}`;
  }

  private update(entry: ItemEntry, snapshot: ReviewExpansionSnapshot): void {
    entry.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function sameChangedLines(partial: FileDiffMetadata, complete: FileDiffMetadata): boolean {
  return JSON.stringify(changedLines(partial)) === JSON.stringify(changedLines(complete));
}

function changedLines(fileDiff: FileDiffMetadata): { additions: string[]; deletions: string[] } {
  const additions: string[] = [];
  const deletions: string[] = [];
  for (const hunk of fileDiff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== "change") continue;
      additions.push(...fileDiff.additionLines.slice(
        content.additionLineIndex,
        content.additionLineIndex + content.additions,
      ));
      deletions.push(...fileDiff.deletionLines.slice(
        content.deletionLineIndex,
        content.deletionLineIndex + content.deletions,
      ));
    }
  }
  return { additions, deletions };
}

function syntheticEmptyFile(name: string, side: "old" | "new"): FileContents {
  return { name, contents: "", cacheKey: `synthetic-empty:${side}:${encodeURIComponent(name)}` };
}
