import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import type { FilePair } from "./file-contents.js";
import type { FileChange } from "./file-changes.js";

export function buildFileDiff(change: FileChange, files: FilePair): FileDiffMetadata {
  const cacheKey = `${files.oldFile.cacheKey}:${files.newFile.cacheKey}`;
  const reconstructed = processFile(change.filePatch, {
    ...files,
    cacheKey,
    throwOnError: true,
  });
  if (!reconstructed) throw new Error("Complete diff reconstruction failed");
  if (!sameChangedLines(change.fileDiff, reconstructed)) {
    throw new Error("Complete contents no longer match the reviewed diff");
  }
  return {
    ...reconstructed,
    name: change.fileDiff.name,
    type: change.fileDiff.type,
    cacheKey,
    ...(change.fileDiff.prevName ? { prevName: change.fileDiff.prevName } : {}),
    ...(change.fileDiff.lang ? { lang: change.fileDiff.lang } : {}),
    ...(change.fileDiff.newObjectId ? { newObjectId: change.fileDiff.newObjectId } : {}),
    ...(change.fileDiff.prevObjectId ? { prevObjectId: change.fileDiff.prevObjectId } : {}),
    ...(change.fileDiff.mode ? { mode: change.fileDiff.mode } : {}),
    ...(change.fileDiff.prevMode ? { prevMode: change.fileDiff.prevMode } : {}),
  };
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
