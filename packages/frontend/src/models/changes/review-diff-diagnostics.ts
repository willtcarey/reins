import type { FileDiffMetadata } from "@pierre/diffs";
import type { PierreRenderEvent } from "../../controllers/pierre-renderer.js";
import { clientTelemetry } from "../client-telemetry.js";

const inputIds = new WeakMap<FileDiffMetadata, number>();
let nextInputId = 0;
const NULL_DIFF_LINES = "DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null, something is wrong";

/** Content-free, bounded snapshots; metadata can be hydrated in place between events. */
export function createReviewDiffObserver() {
  const operation = clientTelemetry.startOperation("review-renderer");
  return (event: PierreRenderEvent, target: {
    fileDiff: FileDiffMetadata;
    expansionHistory: readonly unknown[];
  }, generation: number, error?: unknown) => {
    operation.record(event, () => {
      const diff = target.fileDiff;
      let inputId = inputIds.get(diff);
      if (inputId === undefined) {
        inputId = ++nextInputId;
        inputIds.set(diff, inputId);
      }
      return {
        generation,
        inputId,
        partial: diff.isPartial === true,
        additionLineCount: diff.additionLines.length,
        deletionLineCount: diff.deletionLines.length,
        unifiedLineCount: diff.unifiedLineCount,
        splitLineCount: diff.splitLineCount,
        expansionCount: target.expansionHistory.length,
        hunkCount: diff.hunks.length,
        hunksTruncated: diff.hunks.length > 4,
        hunks: diff.hunks.slice(0, 4).map((hunk) => ({
          additionStart: hunk.additionStart,
          additionCount: hunk.additionCount,
          additionLineIndex: hunk.additionLineIndex,
          deletionStart: hunk.deletionStart,
          deletionCount: hunk.deletionCount,
          deletionLineIndex: hunk.deletionLineIndex,
          collapsedBefore: hunk.collapsedBefore,
          unifiedLineStart: hunk.unifiedLineStart,
          unifiedLineCount: hunk.unifiedLineCount,
          segmentCount: hunk.hunkContent.length,
        })),
        ...(event === "failed" ? {
          // Arbitrary messages/stacks can contain source or paths. Export only
          // the known assertion's classification, never the original error.
          failure: error instanceof Error && error.message === NULL_DIFF_LINES
            ? "null-diff-lines" : "other",
        } : {}),
      };
    });
    if (event === "failed") void clientTelemetry.flush().catch(() => {});
  };
}
