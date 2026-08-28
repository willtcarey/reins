import type { FileContents, FileDiffMetadata, HunkExpansionRegion } from "@pierre/diffs";
import { buildFileDiff } from "./file-diff.js";
import {
  loadFileContents,
  UnsupportedFileContents,
  type ExpansionScope,
  type ExpansionUnsupported,
  type FetchResponse,
} from "./file-contents.js";
import type { FileChange } from "./file-changes.js";

export type ExpansionStatus = "idle" | "loading" | "available" | "unsupported" | "error";

export interface ExpansionSnapshot {
  readonly outcome: ExpansionStatus;
  /** The original partial metadata until complete contents are available. */
  readonly fileDiff: FileDiffMetadata;
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents | null;
  /** Opaque Pierre-owned regions retained only to restore a virtual remount. */
  readonly nativeExpandedHunks: ReadonlyMap<number, HunkExpansionRegion>;
  readonly unsupported: ExpansionUnsupported | null;
  readonly error: string | null;
}

type Listener = () => void;

interface ItemEntry {
  snapshot: ExpansionSnapshot;
  request: Promise<void> | null;
}

/** Persistent lazy context state whose lifetime outlasts virtual item mounts. */
export class ExpansionState {
  private readonly entries = new Map<string, ItemEntry>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly scope: ExpansionScope,
    private readonly fetchResponse: FetchResponse = (input, init) => fetch(input, init),
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  forChange(change: FileChange): ExpansionSnapshot {
    return this.entryFor(change).snapshot;
  }

  /** Concurrent first native interactions share one complete-content request. */
  async acquire(change: FileChange): Promise<ExpansionSnapshot> {
    const entry = this.entryFor(change);
    if (entry.snapshot.outcome === "idle") {
      this.update(entry, { ...entry.snapshot, outcome: "loading" });
      entry.request = this.load(change, entry);
    }
    if (entry.request) await entry.request;
    return entry.snapshot;
  }

  /** Retain Pierre's own expansion state without deriving or mutating regions. */
  retainNativeExpansion(change: FileChange, regions: ReadonlyMap<number, HunkExpansionRegion>): void {
    const entry = this.entryFor(change);
    const nativeExpandedHunks = new Map<number, HunkExpansionRegion>();
    for (const [index, region] of regions) nativeExpandedHunks.set(index, { ...region });
    entry.snapshot = { ...entry.snapshot, nativeExpandedHunks };
  }

  private entryFor(change: FileChange): ItemEntry {
    const key = `${change.id}\0${change.contentKey}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        snapshot: {
          outcome: "idle",
          fileDiff: change.fileDiff,
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

  private async load(change: FileChange, entry: ItemEntry): Promise<void> {
    try {
      const files = await loadFileContents(change, this.scope, this.fetchResponse);
      const fileDiff = buildFileDiff(change, files);
      this.update(entry, {
        ...entry.snapshot,
        outcome: "available",
        fileDiff,
        oldFile: files.oldFile,
        newFile: files.newFile,
      });
    } catch (error) {
      if (error instanceof UnsupportedFileContents) {
        this.update(entry, {
          ...entry.snapshot,
          outcome: "unsupported",
          unsupported: error.unsupported,
        });
      } else {
        this.update(entry, {
          ...entry.snapshot,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      entry.request = null;
    }
  }

  private update(entry: ItemEntry, snapshot: ExpansionSnapshot): void {
    entry.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
