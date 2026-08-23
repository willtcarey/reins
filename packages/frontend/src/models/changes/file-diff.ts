import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import type { FilePair } from "./file-contents.js";
import type { ReviewItem } from "./review-items.js";

export function buildFileDiff(item: ReviewItem, files: FilePair): FileDiffMetadata {
  const cacheKey = `${files.oldFile.cacheKey}:${files.newFile.cacheKey}`;
  const reconstructed = processFile(item.filePatch, {
    ...files,
    cacheKey,
    throwOnError: true,
  });
  if (!reconstructed) throw new Error("Complete diff reconstruction failed");
  if (!sameChangedLines(item.fileDiff, reconstructed)) {
    throw new Error("Complete contents no longer match the reviewed diff");
  }
  return {
    ...reconstructed,
    name: item.fileDiff.name,
    type: item.fileDiff.type,
    cacheKey,
    ...(item.fileDiff.prevName ? { prevName: item.fileDiff.prevName } : {}),
    ...(item.fileDiff.lang ? { lang: item.fileDiff.lang } : {}),
    ...(item.fileDiff.newObjectId ? { newObjectId: item.fileDiff.newObjectId } : {}),
    ...(item.fileDiff.prevObjectId ? { prevObjectId: item.fileDiff.prevObjectId } : {}),
    ...(item.fileDiff.mode ? { mode: item.fileDiff.mode } : {}),
    ...(item.fileDiff.prevMode ? { prevMode: item.fileDiff.prevMode } : {}),
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
