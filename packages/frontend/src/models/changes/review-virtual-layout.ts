import { DEFAULT_VIRTUAL_FILE_METRICS } from "@pierre/diffs";
import type { ReviewItem } from "./review-items.js";

const REVIEW_HEADER_HEIGHT = 37;
const REVIEW_ITEM_GAP = 16;
const PIERRE_LINE_HEIGHT = DEFAULT_VIRTUAL_FILE_METRICS.lineHeight;
const PIERRE_SPACING = DEFAULT_VIRTUAL_FILE_METRICS.spacing;
const PIERRE_HUNK_SEPARATOR_HEIGHT = DEFAULT_VIRTUAL_FILE_METRICS.hunkSeparatorHeight ?? 32;

export function reviewItemGap(index: number): number {
  return index === 0 ? 0 : REVIEW_ITEM_GAP;
}

export function estimateReviewItemHeight(
  item: ReviewItem,
  collapsed: boolean,
  index: number,
): number {
  const gap = reviewItemGap(index);
  if (collapsed) return gap + REVIEW_HEADER_HEIGHT;

  let bodyHeight = PIERRE_SPACING;
  for (const [hunkIndex, hunk] of item.fileDiff.hunks.entries()) {
    if (hunk.collapsedBefore > 0) {
      bodyHeight += PIERRE_HUNK_SEPARATOR_HEIGHT + PIERRE_SPACING;
      if (hunkIndex > 0) bodyHeight += PIERRE_SPACING;
    }
    bodyHeight += hunk.unifiedLineCount * PIERRE_LINE_HEIGHT;
    bodyHeight += unifiedMetadataRows(hunk) * PIERRE_LINE_HEIGHT;
  }
  if (item.fileDiff.hunks.length > 0) bodyHeight += PIERRE_SPACING;

  return gap + REVIEW_HEADER_HEIGHT + bodyHeight;
}

type ReviewHunk = ReviewItem["fileDiff"]["hunks"][number];

function unifiedMetadataRows(hunk: ReviewHunk): number {
  if (!hunk.noEOFCRAdditions && !hunk.noEOFCRDeletions) return 0;
  const content = hunk.hunkContent.at(-1);
  if (!content) return 0;
  if (content.type === "context") return content.lines > 0 ? 1 : 0;

  return (content.deletions > 0 && hunk.noEOFCRDeletions ? 1 : 0)
    + (content.additions > 0 && hunk.noEOFCRAdditions ? 1 : 0);
}

export interface ReviewVirtualLayoutInput {
  readonly id: string;
  readonly height: number;
}

export interface ReviewVirtualLayoutItem extends ReviewVirtualLayoutInput {
  readonly top: number;
}

export interface ReviewVirtualLayout {
  readonly items: readonly ReviewVirtualLayoutItem[];
  readonly byId: ReadonlyMap<string, ReviewVirtualLayoutItem>;
  readonly totalHeight: number;
}

export interface ReviewVirtualViewport {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly overscanBefore: number;
  readonly overscanAfter: number;
}

export interface ReviewVirtualWindow {
  readonly items: readonly ReviewVirtualLayoutItem[];
  readonly activeId: string | null;
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

export function createReviewVirtualLayout(
  inputs: readonly ReviewVirtualLayoutInput[],
): ReviewVirtualLayout {
  let top = 0;
  const items = inputs.map((input) => {
    const item = { ...input, height: Math.max(1, input.height), top };
    top += item.height;
    return item;
  });

  return {
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    totalHeight: top,
  };
}

export function reviewVirtualWindow(
  layout: ReviewVirtualLayout,
  viewport: ReviewVirtualViewport,
): ReviewVirtualWindow {
  if (layout.items.length === 0) {
    return { items: [], activeId: null, paddingTop: 0, paddingBottom: 0 };
  }

  const scrollTop = Math.max(0, viewport.scrollTop);
  const start = Math.max(0, scrollTop - viewport.overscanBefore);
  const end = scrollTop + Math.max(1, viewport.viewportHeight) + viewport.overscanAfter;
  const firstIndex = firstItemEndingAfter(layout.items, start);
  const lastIndex = firstItemStartingAtOrAfter(layout.items, end);
  const items = layout.items.slice(firstIndex, Math.max(firstIndex + 1, lastIndex));
  const first = items[0];
  const last = items.at(-1);
  const active = layout.items[firstItemEndingAfter(layout.items, scrollTop)];

  return {
    items,
    activeId: active?.id ?? layout.items.at(-1)?.id ?? null,
    paddingTop: first?.top ?? 0,
    paddingBottom: last ? Math.max(0, layout.totalHeight - last.top - last.height) : 0,
  };
}

export function measureReviewVirtualLayout(
  layout: ReviewVirtualLayout,
  id: string,
  measuredHeight: number,
  anchorScrollTop: number,
): { changed: boolean; scrollAdjustment: number } {
  const item = layout.byId.get(id);
  if (!item) return { changed: false, scrollAdjustment: 0 };

  const height = Math.max(1, measuredHeight);
  const delta = height - item.height;
  return {
    changed: delta !== 0,
    scrollAdjustment: item.top + item.height <= anchorScrollTop ? delta : 0,
  };
}

function firstItemEndingAfter(items: readonly ReviewVirtualLayoutItem[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = items[middle]!;
    if (item.top + item.height <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, items.length - 1);
}

function firstItemStartingAtOrAfter(items: readonly ReviewVirtualLayoutItem[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.top < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
