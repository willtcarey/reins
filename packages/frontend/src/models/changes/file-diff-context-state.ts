import type {
  ExpansionDirections,
  FileContents,
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from "@pierre/diffs";
import { buildFileDiff } from "./file-diff.js";
import {
  loadFileContents,
  UnsupportedFileContents,
  type FileDiffContextScope,
  type ExpansionUnsupported,
  type FetchResponse,
} from "./file-contents.js";
import type { FileChange } from "./file-changes.js";

export type FileDiffContextStatus = "idle" | "loading" | "available" | "unsupported" | "error";

export interface FileDiffExpansionCommand {
  readonly hunkIndex: number;
  readonly direction: ExpansionDirections;
  readonly lineCount?: number;
}

export interface FileDiffContextSnapshot {
  readonly outcome: FileDiffContextStatus;
  /** Stable metadata that Pierre upgrades in place after loading full contents. */
  readonly fileDiff: FileDiffMetadata;
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents | null;
  /** Public expansion commands retained to replay across virtual remounts. */
  readonly expansionHistory: readonly FileDiffExpansionCommand[];
  readonly unsupported: ExpansionUnsupported | null;
  readonly error: string | null;
}

type Listener = (changeId: string) => void;

interface ItemEntry {
  snapshot: FileDiffContextSnapshot;
  request: Promise<FileDiffLoadedFiles> | null;
  failure: unknown | null;
}

/** Persistent lazy context state whose lifetime outlasts virtual item mounts. */
export class FileDiffContextState {
  private readonly entries = new Map<string, ItemEntry>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly scope: FileDiffContextScope,
    private readonly fetchResponse: FetchResponse = (input, init) => fetch(input, init),
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  forChange(change: FileChange): FileDiffContextSnapshot {
    return this.entryFor(change).snapshot;
  }

  /** Pierre's native async expansion loader; concurrent calls share one request. */
  loadFiles(change: FileChange): Promise<FileDiffLoadedFiles> {
    const entry = this.entryFor(change);
    if (entry.snapshot.outcome === "available") return Promise.resolve(loadedFiles(entry.snapshot));
    if (entry.failure !== null) return Promise.reject(entry.failure);
    if (!entry.request) {
      this.update(change.id, entry, { ...entry.snapshot, outcome: "loading" });
      entry.request = this.load(change, entry).finally(() => { entry.request = null; });
    }
    return entry.request;
  }

  retainExpansion(change: FileChange, command: FileDiffExpansionCommand): void {
    const entry = this.entryFor(change);
    entry.snapshot = {
      ...entry.snapshot,
      expansionHistory: [...entry.snapshot.expansionHistory, { ...command }],
    };
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
          expansionHistory: [],
          unsupported: null,
          error: null,
        },
        request: null,
        failure: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async load(change: FileChange, entry: ItemEntry): Promise<FileDiffLoadedFiles> {
    try {
      const files = await loadFileContents(change, this.scope, this.fetchResponse);
      // Pierre owns hydration, but Reins validates the fetched snapshot against
      // the exact Git patch before allowing the native renderer to install it.
      buildFileDiff(change, files);
      this.update(change.id, entry, {
        ...entry.snapshot,
        outcome: "available",
        oldFile: files.oldFile,
        newFile: files.newFile,
      });
      return files;
    } catch (error) {
      entry.failure = error;
      if (error instanceof UnsupportedFileContents) {
        this.update(change.id, entry, {
          ...entry.snapshot,
          outcome: "unsupported",
          unsupported: error.unsupported,
        });
      } else {
        this.update(change.id, entry, {
          ...entry.snapshot,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private update(changeId: string, entry: ItemEntry, snapshot: FileDiffContextSnapshot): void {
    entry.snapshot = snapshot;
    for (const listener of this.listeners) listener(changeId);
  }
}

function loadedFiles(snapshot: FileDiffContextSnapshot): FileDiffLoadedFiles {
  if (snapshot.newFile === null) throw new Error("Complete new file contents are unavailable");
  if (snapshot.fileDiff.type === "rename-pure") return { oldFile: null, newFile: snapshot.newFile };
  if (snapshot.oldFile === null) throw new Error("Complete old file contents are unavailable");
  return { oldFile: snapshot.oldFile, newFile: snapshot.newFile };
}
