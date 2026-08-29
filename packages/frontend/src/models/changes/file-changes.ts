import { parsePatchFiles, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs";
import { compareFilePaths } from "./diff-sort.js";

export interface FileChange {
  readonly id: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: ChangeTypes;
  readonly additions: number;
  readonly removals: number;
  readonly occurrence: number;
  /** Compact fingerprint computed once while parsing; never raw serialized diff content. */
  readonly contentKey: string;
  readonly cacheKey: string;
  /** Exact Git patch segment used to hydrate complete Pierre metadata lazily. */
  readonly filePatch: string;
  readonly fileDiff: FileDiffMetadata;
}

export interface FileChangesResult {
  readonly changes: FileChange[];
  readonly pathToChangeId: Map<string, string>;
  readonly parseError: string | null;
}

/** Preserve record identity by stable ID when content is unchanged. */
export function reconcileFileChanges(
  previous: FileChangesResult | null,
  next: FileChangesResult,
): FileChangesResult {
  if (!previous || next.parseError) return next;

  const previousById = new Map(previous.changes.map((change) => [change.id, change]));
  const changes = next.changes.map((change) => {
    const candidate = previousById.get(change.id);
    if (!candidate) return change;
    if (candidate.contentKey === change.contentKey) return candidate;
    return change;
  });
  return { ...next, changes };
}

/**
 * Converts a complete raw patch into renderer-owned records. The records are
 * independent from DiffStore.fullData so a later virtual list can change only
 * the mounting strategy.
 */
export function parseFileChanges(
  patch: string,
  cacheKeyPrefix: string,
): FileChangesResult {
  try {
    const parsedPatches = parsePatchFiles(patch, undefined, true);
    const occurrences = new Map<string, number>();
    const changes: FileChange[] = [];
    const filePatches = splitFilePatches(patch);
    let filePatchIndex = 0;

    for (const parsedPatch of parsedPatches) {
      for (const parsedFileDiff of parsedPatch.files) {
        const filePatch = filePatches[filePatchIndex++];
        if (!filePatch) throw new Error("Unable to retain the per-file patch");
        const path = parsedFileDiff.name;
        const oldPath = parsedFileDiff.prevName ?? null;
        const status = parsedFileDiff.type;
        const occurrenceKey = fileChangeIdentity(status, oldPath, path);
        const occurrence = occurrences.get(occurrenceKey) ?? 0;
        occurrences.set(occurrenceKey, occurrence + 1);
        const identity = `${occurrenceKey}:${occurrence}`;
        const contentKey = contentFingerprint(JSON.stringify(
          { fileDiff: parsedFileDiff, filePatch },
          (key, value) => key === "cacheKey" ? undefined : value,
        ));
        const cacheKey = `${cacheKeyPrefix}:${identity}`;
        const fileDiff = { ...parsedFileDiff, cacheKey };
        const additions = fileDiff.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
        const removals = fileDiff.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);

        changes.push({
          id: `review:${identity}`,
          path,
          oldPath,
          status,
          additions,
          removals,
          occurrence,
          contentKey,
          cacheKey,
          filePatch,
          fileDiff,
        });
      }
    }

    changes.sort((a, b) => compareFilePaths(a.path, b.path));
    const pathToChangeId = new Map<string, string>();
    for (const change of changes) {
      if (!pathToChangeId.has(change.path)) pathToChangeId.set(change.path, change.id);
      if (change.oldPath && !pathToChangeId.has(change.oldPath)) {
        pathToChangeId.set(change.oldPath, change.id);
      }
    }

    return { changes, pathToChangeId, parseError: null };
  } catch (error) {
    return {
      changes: [],
      pathToChangeId: new Map(),
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function splitFilePatches(patch: string): string[] {
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function fileChangeIdentity(status: ChangeTypes, oldPath: string | null, path: string): string {
  return `${status}:${oldPath ? encodeURIComponent(oldPath) : ""}:${encodeURIComponent(path)}`;
}

/** Compact deterministic identity; diff content is not security-sensitive input. */
function contentFingerprint(content: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second = (second << 13) | (second >>> 19);
  }
  return `v1:${toHex(first)}${toHex(second)}:${content.length.toString(36)}`;
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
