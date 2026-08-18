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
  readonly overscan: number;
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
  const start = Math.max(0, scrollTop - viewport.overscan);
  const end = scrollTop + Math.max(1, viewport.viewportHeight) + viewport.overscan;
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
