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

export interface ReviewVirtualItemInput {
  readonly id: string;
  /** Changes whenever a previous measurement is no longer valid. */
  readonly measurementKey: string;
  readonly estimatedHeight: number;
}

export interface ReviewVirtualItem extends ReviewVirtualItemInput {
  readonly top: number;
  readonly height: number;
}

export interface ReviewVirtualAnchor {
  readonly id: string;
  readonly viewportOffset: number;
}

export interface ReviewVirtualWindow {
  readonly items: readonly ReviewVirtualItem[];
  readonly activeId: string | null;
  readonly totalHeight: number;
}

export interface ReviewVirtualMeasurement {
  readonly id: string;
  readonly measurementKey: string;
  readonly height: number;
  readonly stable: boolean;
}

export interface ReviewVirtualGeometryUpdate {
  readonly accepted: number;
  readonly scrollTop: number;
  readonly scrollAdjustment: number;
}

/**
 * Persistent top-level review geometry and anchoring state.
 *
 * Lit owns mounted nodes, while this coordinator retains every item's last
 * stable measurement. Geometry changes are committed as batches against one
 * semantic item + viewport-offset anchor, so callers apply at most one scroll
 * correction before rendering the new absolute positions.
 */
export class ReviewVirtualCoordinator {
  private readonly measurements = new Map<string, number>();
  private inputs: readonly ReviewVirtualItemInput[] = [];
  private items: readonly ReviewVirtualItem[] = [];
  private byId = new Map<string, ReviewVirtualItem>();
  private scrollTop = 0;
  private viewportHeight = 1;
  private totalHeight = 0;
  public layoutVersion = 0;

  constructor(private readonly overscan: number) {}

  public setItems(inputs: readonly ReviewVirtualItemInput[]): ReviewVirtualGeometryUpdate {
    const anchor = this.anchor();
    this.inputs = inputs.map((input) => ({
      ...input,
      estimatedHeight: Math.max(1, input.estimatedHeight),
    }));
    const validMeasurementKeys = new Set(this.inputs.flatMap((input) => [
      input.measurementKey,
      alternateRenderStateKey(input.measurementKey),
    ]));
    for (const key of this.measurements.keys()) {
      if (!validMeasurementKeys.has(key)) this.measurements.delete(key);
    }
    this.rebuild();
    return this.resolveGeometryUpdate(anchor, 0);
  }

  public setViewport(scrollTop: number, viewportHeight: number) {
    this.viewportHeight = Math.max(1, viewportHeight);
    this.scrollTop = this.clampScrollTop(scrollTop);
  }

  public measure(measurements: readonly ReviewVirtualMeasurement[]): ReviewVirtualGeometryUpdate {
    const anchor = this.anchor();
    let accepted = 0;

    for (const measurement of measurements) {
      const item = this.byId.get(measurement.id);
      if (
        !measurement.stable
        || !item
        || item.measurementKey !== measurement.measurementKey
        || measurement.height <= 0
      ) continue;
      const height = Math.max(1, measurement.height);
      if (this.measurements.get(measurement.measurementKey) === height) continue;
      this.measurements.set(measurement.measurementKey, height);
      accepted += 1;
    }

    if (accepted === 0) return { accepted: 0, scrollTop: this.scrollTop, scrollAdjustment: 0 };
    this.rebuild();
    return this.resolveGeometryUpdate(anchor, accepted);
  }

  public window(): ReviewVirtualWindow {
    if (this.items.length === 0) return { items: [], activeId: null, totalHeight: 0 };

    const start = Math.max(0, this.scrollTop - this.overscan);
    const end = this.scrollTop + this.viewportHeight + this.overscan;
    const first = firstItemEndingAfter(this.items, start);
    const last = firstItemStartingAtOrAfter(this.items, end);
    const active = this.items[firstItemEndingAfter(this.items, this.scrollTop)];

    return {
      items: this.items.slice(first, Math.max(first + 1, last)),
      activeId: active?.id ?? this.items.at(-1)?.id ?? null,
      totalHeight: this.totalHeight,
    };
  }

  public anchor(): ReviewVirtualAnchor | null {
    if (this.items.length === 0) return null;
    const item = this.items[firstItemEndingAfter(this.items, this.scrollTop)];
    return item ? { id: item.id, viewportOffset: item.top - this.scrollTop } : null;
  }

  public item(id: string): ReviewVirtualItem | undefined {
    return this.byId.get(id);
  }

  public navigationTop(id: string): number | null {
    const item = this.byId.get(id);
    return item ? this.clampScrollTop(item.top) : null;
  }

  private rebuild() {
    let top = 0;
    this.items = this.inputs.map((input) => {
      const height = this.measurements.get(input.measurementKey) ?? input.estimatedHeight;
      const item = { ...input, top, height };
      top += height;
      return item;
    });
    this.byId = new Map(this.items.map((item) => [item.id, item]));
    this.totalHeight = top;
    this.layoutVersion += 1;
  }

  private resolveGeometryUpdate(
    anchor: ReviewVirtualAnchor | null,
    accepted: number,
  ): ReviewVirtualGeometryUpdate {
    const previous = this.scrollTop;
    const anchoredItem = anchor ? this.byId.get(anchor.id) : undefined;
    this.scrollTop = anchoredItem
      ? this.clampScrollTop(anchoredItem.top - anchor!.viewportOffset)
      : this.clampScrollTop(this.scrollTop);
    return {
      accepted,
      scrollTop: this.scrollTop,
      scrollAdjustment: this.scrollTop - previous,
    };
  }

  private clampScrollTop(value: number): number {
    return Math.max(0, Math.min(value, Math.max(0, this.totalHeight - this.viewportHeight)));
  }
}

function alternateRenderStateKey(key: string): string {
  if (key.endsWith(":expanded")) return `${key.slice(0, -":expanded".length)}:collapsed`;
  if (key.endsWith(":collapsed")) return `${key.slice(0, -":collapsed".length)}:expanded`;
  return key;
}

function firstItemEndingAfter(items: readonly ReviewVirtualItem[], offset: number): number {
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

function firstItemStartingAtOrAfter(items: readonly ReviewVirtualItem[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.top < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
