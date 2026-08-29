import { DEFAULT_VIRTUAL_FILE_METRICS } from "@pierre/diffs";
import type { FileChange } from "./file-changes.js";
import { isDiffRenderBlocked } from "./diff-render-limit.js";

const REVIEW_HEADER_HEIGHT = 37;
const REVIEW_ITEM_GAP = 16;
const REVIEW_BLOCKED_BODY_HEIGHT = 53;
const PIERRE_LINE_HEIGHT = DEFAULT_VIRTUAL_FILE_METRICS.lineHeight;
const PIERRE_SPACING = DEFAULT_VIRTUAL_FILE_METRICS.spacing;
const PIERRE_HUNK_SEPARATOR_HEIGHT = DEFAULT_VIRTUAL_FILE_METRICS.hunkSeparatorHeight ?? 32;

export function fileChangeGap(index: number): number {
  return index === 0 ? 0 : REVIEW_ITEM_GAP;
}

export function estimateFileChangeHeight(
  change: FileChange,
  collapsed: boolean,
): number {
  if (collapsed) return REVIEW_HEADER_HEIGHT;
  if (isDiffRenderBlocked(change)) return REVIEW_HEADER_HEIGHT + REVIEW_BLOCKED_BODY_HEIGHT;

  let bodyHeight = PIERRE_SPACING;
  for (const [hunkIndex, hunk] of change.fileDiff.hunks.entries()) {
    if (hunk.collapsedBefore > 0) {
      bodyHeight += PIERRE_HUNK_SEPARATOR_HEIGHT + PIERRE_SPACING;
      if (hunkIndex > 0) bodyHeight += PIERRE_SPACING;
    }
    bodyHeight += hunk.unifiedLineCount * PIERRE_LINE_HEIGHT;
    bodyHeight += unifiedMetadataRows(hunk) * PIERRE_LINE_HEIGHT;
  }
  if (change.fileDiff.hunks.length > 0) bodyHeight += PIERRE_SPACING;

  return REVIEW_HEADER_HEIGHT + bodyHeight;
}

type ReviewHunk = FileChange["fileDiff"]["hunks"][number];

function unifiedMetadataRows(hunk: ReviewHunk): number {
  if (!hunk.noEOFCRAdditions && !hunk.noEOFCRDeletions) return 0;
  const content = hunk.hunkContent.at(-1);
  if (!content) return 0;
  if (content.type === "context") return content.lines > 0 ? 1 : 0;

  return (content.deletions > 0 && hunk.noEOFCRDeletions ? 1 : 0)
    + (content.additions > 0 && hunk.noEOFCRAdditions ? 1 : 0);
}
