export interface VirtualListItemInput {
  readonly id: string;
  readonly estimatedHeight: number;
  /** Changes whenever a previously measured fluid height is no longer valid. */
  readonly measurementKey: string;
  /** Temporarily replaces fluid geometry without discarding its measurement. */
  readonly fixedHeight?: number;
}

export interface VirtualListItem extends VirtualListItemInput {
  readonly top: number;
  readonly height: number;
}

export interface VirtualListAnchor {
  readonly id: string;
  readonly viewportOffset: number;
}

export interface VirtualListWindow {
  readonly items: readonly VirtualListItem[];
  readonly activeId: string | null;
  readonly totalHeight: number;
}

export interface VirtualListMeasurement {
  readonly id: string;
  readonly measurementKey: string;
  readonly height: number;
}

export interface VirtualListGeometryUpdate {
  readonly accepted: number;
  readonly scrollTop: number;
  readonly scrollAdjustment: number;
}

/**
 * Persistent estimated/measured geometry for a bounded virtual list.
 *
 * The coordinator has no DOM or rendering policy. It retains stable fluid
 * measurements, resolves windows and unmounted offsets, and applies geometry
 * batches against one semantic item-and-viewport-offset anchor.
 */
export class VirtualListCoordinator {
  private readonly measurements = new Map<string, number>();
  private inputs: readonly VirtualListItemInput[] = [];
  private items: readonly VirtualListItem[] = [];
  private byId = new Map<string, VirtualListItem>();
  private scrollTop = 0;
  private viewportHeight = 1;
  private totalHeight = 0;
  public layoutVersion = 0;

  constructor(private readonly overscan: number) {}

  public setItems(inputs: readonly VirtualListItemInput[]): VirtualListGeometryUpdate {
    const anchor = this.anchor();
    this.inputs = inputs.map((input) => ({
      ...input,
      estimatedHeight: Math.max(1, input.estimatedHeight),
      fixedHeight: input.fixedHeight === undefined ? undefined : Math.max(1, input.fixedHeight),
    }));
    const validMeasurementKeys = new Set(this.inputs.map((input) => input.measurementKey));
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

  public measure(measurements: readonly VirtualListMeasurement[]): VirtualListGeometryUpdate {
    const anchor = this.anchor();
    let accepted = 0;

    for (const measurement of measurements) {
      const item = this.byId.get(measurement.id);
      if (
        !item
        || item.fixedHeight !== undefined
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

  public window(): VirtualListWindow {
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

  public anchor(): VirtualListAnchor | null {
    if (this.items.length === 0) return null;
    const item = this.items[firstItemEndingAfter(this.items, this.scrollTop)];
    return item ? { id: item.id, viewportOffset: item.top - this.scrollTop } : null;
  }

  public item(id: string): VirtualListItem | undefined {
    return this.byId.get(id);
  }

  public get totalSize(): number {
    return this.totalHeight;
  }

  public navigationTop(id: string): number | null {
    const item = this.byId.get(id);
    return item ? this.clampScrollTop(item.top) : null;
  }

  private rebuild() {
    let top = 0;
    this.items = this.inputs.map((input) => {
      const height = input.fixedHeight
        ?? this.measurements.get(input.measurementKey)
        ?? input.estimatedHeight;
      const item = { ...input, top, height };
      top += height;
      return item;
    });
    this.byId = new Map(this.items.map((item) => [item.id, item]));
    this.totalHeight = top;
    this.layoutVersion += 1;
  }

  private resolveGeometryUpdate(
    anchor: VirtualListAnchor | null,
    accepted: number,
  ): VirtualListGeometryUpdate {
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

function firstItemEndingAfter(items: readonly VirtualListItem[], offset: number): number {
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

function firstItemStartingAtOrAfter(items: readonly VirtualListItem[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.top < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
