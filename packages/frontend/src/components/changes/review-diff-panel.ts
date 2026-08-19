import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ReviewCollapseState,
  type ReviewCollapseScope,
} from "../../models/changes/review-collapse-state.js";
import {
  parseReviewItems,
  reconcileReviewItems,
  type ReviewItem,
  type ReviewItemsResult,
} from "../../models/changes/review-items.js";
import {
  createReviewVirtualLayout,
  estimateReviewItemHeight,
  measureReviewVirtualLayout,
  reviewItemGap,
  reviewVirtualWindow,
  type ReviewVirtualLayout,
} from "../../models/changes/review-virtual-layout.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import { activeFileChangeEvent, activeItemChangeEvent } from "../events.js";
import { branchIcon } from "../icons.js";
import { ReviewDiffItem } from "./review-diff-item.js";

const DEFAULT_VIEWPORT_HEIGHT = 800;
const REVIEW_ITEM_OVERSCAN = 600;

type ScrollPositionContainer = Pick<HTMLElement, "scrollTop" | "clientHeight">;
type MeasuredReviewItem = { expanded?: number; collapsed?: number };

export class ReviewScrollPosition {
  private value: number | null = null;

  remember(container: ScrollPositionContainer, visible: boolean) {
    if (!visible || container.clientHeight <= 0) return;
    this.value = container.scrollTop;
  }

  restore(container: ScrollPositionContainer, visible: boolean): boolean {
    if (!visible || container.clientHeight <= 0 || this.value === null) return false;
    container.scrollTop = this.value;
    return true;
  }

  reset() {
    this.value = null;
  }
}

/**
 * Reins-owned review renderer. Review records and interaction state stay in
 * this panel while render() derives a bounded DOM window from their geometry.
 */
@customElement("review-diff-panel")
export class ReviewDiffPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _store: DiffStore | null = null;
  private _activeItemId: string | null = null;

  @property({ attribute: false })
  get store(): DiffStore | null {
    return this._store;
  }

  set store(value: DiffStore | null) {
    const oldValue = this._store;
    if (value === oldValue) return;

    this._store = value;
    this._scrollPosition.reset();
    this._viewportScrollTop = 0;
    this._resetParsedData();
    this._reconcilePatchData();
    this.requestUpdate("store", oldValue);
  }

  @property({ type: Boolean }) visible = false;

  private _unsubscribe: (() => void) | null = null;
  private _pendingPath: string | null = null;
  private _parsedSource: DiffPatchData | null = null;
  private _parsedData: ReviewItemsResult | null = null;
  private _scrollPosition = new ReviewScrollPosition();
  private _collapseState = new ReviewCollapseState();
  private _measurements = new WeakMap<ReviewItem, MeasuredReviewItem>();
  private _resizeObserver: ResizeObserver | null = null;
  private _viewportScrollTop = 0;
  private _viewportHeight = DEFAULT_VIEWPORT_HEIGHT;
  private _renderFrame: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override willUpdate(changed: Map<string, unknown>) {
    const storeChanged = changed.has("store");
    if (storeChanged) this._subscribe();
    this._reconcilePatchData();
    if (this.visible && (storeChanged || changed.has("visible"))) this._fetchFresh();
  }

  override updated(changed: Map<string, unknown>) {
    this._observeGeometry();
    const data = this._parsedData;
    if (!this._activeItemId && data?.items[0]) this.reportActiveItem(data.items[0].id);
    this._syncPendingScroll();
    if (changed.has("visible") && this.visible) {
      const container = this._scrollContainer();
      if (container && this._scrollPosition.restore(container, true)) {
        this._viewportScrollTop = container.scrollTop;
        this.requestUpdate();
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._renderFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._renderFrame);
    }
    this._renderFrame = null;
    this.store?.clearPatchDiff();
  }

  public itemIdForPath(path: string): string | null {
    return this._parsedData?.pathToItemId.get(path) ?? null;
  }

  public scrollToFile(path: string) {
    this._pendingPath = path;
    if (this.store?.patchData.loading) return;

    const itemId = this.itemIdForPath(path);
    if (!itemId) return;
    if (this.isItemCollapsed(itemId)) this.setItemCollapsed(itemId, false);

    const target = this._reviewLayout().byId.get(itemId);
    const container = this._scrollContainer();
    if (!target || !container) return;

    container.scrollTo({ top: target.top, behavior: "smooth" });
    this._pendingPath = null;
    this.reportActiveItem(itemId);
  }

  public isItemCollapsed(id: string): boolean {
    const item = this._parsedData?.items.find((candidate) => candidate.id === id);
    const scope = this._collapseScope();
    return item && scope ? this._collapseState.isCollapsed(scope, item) : false;
  }

  public setItemCollapsed(id: string, collapsed: boolean) {
    const item = this._parsedData?.items.find((candidate) => candidate.id === id);
    const scope = this._collapseScope();
    if (!item || !scope || this.isItemCollapsed(id) === collapsed) return;

    const container = this._scrollContainer();
    const before = this._reviewLayout();
    const anchorId = reviewVirtualWindow(before, {
      scrollTop: container?.scrollTop ?? this._viewportScrollTop,
      viewportHeight: this._viewportHeight,
      overscanBefore: 0,
      overscanAfter: 0,
    }).activeId;

    this._collapseState.setCollapsed(scope, item, collapsed);

    if (container && anchorId) {
      const after = this._reviewLayout();
      const beforeTop = before.byId.get(anchorId)?.top;
      const afterTop = after.byId.get(anchorId)?.top;
      if (beforeTop !== undefined && afterTop !== undefined) {
        container.scrollTop += afterTop - beforeTop;
        this._viewportScrollTop = container.scrollTop;
      }
    }
    this.requestUpdate();
  }

  public reportActiveItem(id: string) {
    const item = this._parsedData?.items.find((candidate) => candidate.id === id);
    if (!item || this._activeItemId === id) return;
    this._activeItemId = id;

    this.dispatchEvent(activeItemChangeEvent(id));
    this.dispatchEvent(activeFileChangeEvent(item.path));
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (!this.store) return;
    this._unsubscribe = this.store.subscribe(() => {
      if (this.visible && !this.store?.patchData.data && !this.store?.patchData.loading && !this.store?.patchData.error) {
        void this.store?.fetchPatchDiff();
      }
      this._reconcilePatchData();
      this.requestUpdate();
    });
  }

  private _fetchFresh() {
    void this.store?.fetchPatchDiff();
  }

  private _resetParsedData() {
    this._parsedSource = null;
    this._parsedData = null;
    this._activeItemId = null;
    this._measurements = new WeakMap();
  }

  private _reconcilePatchData() {
    const source = this.store?.patchData.data ?? null;
    if (!source) {
      if (this._parsedSource || this._parsedData) this._resetParsedData();
      return;
    }
    if (source === this._parsedSource) return;

    this._parsedSource = source;
    const previousData = this._parsedData;
    this._parsedData = reconcileReviewItems(
      previousData,
      parseReviewItems(source.patch, source.cacheKeyPrefix),
    );
    if (this._activeItemId && !this._parsedData.items.some((item) => item.id === this._activeItemId)) {
      this._activeItemId = null;
    }
  }

  private _collapseScope(): ReviewCollapseScope | null {
    const store = this.store;
    if (store?.projectId == null) return null;
    return {
      projectId: store.projectId,
      branch: this._parsedSource?.branch ?? store.branch,
    };
  }

  private _itemHeight(item: ReviewItem, index: number): number {
    const measurement = this._measurements.get(item);
    const collapsed = this.isItemCollapsed(item.id);
    const measured = collapsed ? measurement?.collapsed : measurement?.expanded;
    return measured !== undefined
      ? measured + reviewItemGap(index)
      : estimateReviewItemHeight(item, collapsed, index);
  }

  private _reviewLayout(): ReviewVirtualLayout {
    return createReviewVirtualLayout(
      (this._parsedData?.items ?? []).map((item, index) => ({
        id: item.id,
        height: this._itemHeight(item, index),
      })),
    );
  }

  private _scrollContainer(): HTMLElement | null {
    if (typeof this.querySelector !== "function") return null;
    return this.querySelector<HTMLElement>("[data-review-scroll]");
  }

  private _handleScroll(event: Event) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const container = event.currentTarget;
    this._viewportScrollTop = container.scrollTop;
    if (container.clientHeight > 0) this._viewportHeight = container.clientHeight;
    this._scrollPosition.remember(container, this.visible);

    const activeId = reviewVirtualWindow(this._reviewLayout(), {
      scrollTop: container.scrollTop + 24,
      viewportHeight: container.clientHeight,
      overscanBefore: 0,
      overscanAfter: 0,
    }).activeId;
    if (activeId) this.reportActiveItem(activeId);
    this._scheduleRender();
  }

  private _scheduleRender() {
    if (this._renderFrame !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      this.requestUpdate();
      return;
    }
    this._renderFrame = requestAnimationFrame(() => {
      this._renderFrame = null;
      this.requestUpdate();
    });
  }

  private _handleToggleCollapse(event: CustomEvent<string>) {
    const id = event.detail;
    this.setItemCollapsed(id, !this.isItemCollapsed(id));
  }

  private _handleDiffRendered(event: Event) {
    if (event.target instanceof HTMLElement) this._recordMeasurements([event.target]);
    this._syncPendingScroll();
  }

  private _syncPendingScroll() {
    if (this.store?.patchData.loading || !this._pendingPath || !this._scrollContainer()) return;
    const path = this._pendingPath;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => this.scrollToFile(path));
    } else {
      setTimeout(() => this.scrollToFile(path), 0);
    }
  }

  private _observeGeometry() {
    if (typeof ResizeObserver === "undefined") return;
    this._resizeObserver ??= new ResizeObserver((entries) => {
      const measuredItems: HTMLElement[] = [];
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        if (entry.target.hasAttribute("data-review-scroll")) {
          const height = entry.contentRect.height;
          if (height > 0 && height !== this._viewportHeight) {
            this._viewportHeight = height;
            this.requestUpdate();
          }
        } else if (entry.target.hasAttribute("data-review-item-id")) {
          measuredItems.push(entry.target);
        }
      }
      this._recordMeasurements(measuredItems);
    });

    this._resizeObserver.disconnect();
    const container = this._scrollContainer();
    if (container) this._resizeObserver.observe(container);
    if (typeof this.querySelectorAll !== "function") return;
    for (const item of this.querySelectorAll<HTMLElement>("[data-review-item-id]")) {
      this._resizeObserver.observe(item);
    }
  }

  private _recordMeasurements(elements: readonly HTMLElement[]) {
    if (elements.length === 0) return;
    const layout = this._reviewLayout();
    const container = this._scrollContainer();
    const anchor = container?.scrollTop ?? this._viewportScrollTop;
    let changed = false;

    for (const element of elements) {
      const id = element.dataset.reviewItemId;
      const index = this._parsedData?.items.findIndex((candidate) => candidate.id === id) ?? -1;
      const item = index >= 0 ? this._parsedData?.items[index] : undefined;
      if (!item) continue;
      const collapsed = this.isItemCollapsed(item.id);
      if (!collapsed && element instanceof ReviewDiffItem && !element.diffRendered) continue;

      const height = element.getBoundingClientRect().height || element.offsetHeight;
      if (height <= 0) continue;
      const result = measureReviewVirtualLayout(layout, item.id, height, anchor);
      if (!result.changed || result.scrollAdjustment !== 0) continue;

      const contentHeight = height - reviewItemGap(index);
      const measurement = this._measurements.get(item) ?? {};
      if (collapsed) measurement.collapsed = contentHeight;
      else measurement.expanded = contentHeight;
      this._measurements.set(item, measurement);
      changed = true;
    }

    if (changed) this.requestUpdate();
  }

  override render() {
    if (!this.store) return nothing;
    if (this.store.patchData.error) {
      return html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Error: ${this.store.patchData.error}</div>`;
    }

    const loading = this.store.patchData.loading && !this.store.patchData.data;
    const data = this._parsedData;
    const items = data?.items ?? [];
    const branch = this._parsedSource?.branch ?? this.store.branch;
    const baseBranch = this._parsedSource?.baseBranch ?? this.store.fileData.data?.baseBranch;
    const layout = this._reviewLayout();
    const virtualWindow = reviewVirtualWindow(layout, {
      scrollTop: this._viewportScrollTop,
      viewportHeight: this._viewportHeight,
      overscanBefore: 0,
      overscanAfter: REVIEW_ITEM_OVERSCAN,
    });
    const itemById = new Map(items.map((item) => [item.id, item]));
    const mountedItems = virtualWindow.items.flatMap((entry) => {
      const item = itemById.get(entry.id);
      return item ? [item] : [];
    });

    return html`
      <div class="flex h-full min-h-0 flex-col" data-rendered-payload-version=${data ? this.store.patchData.data?.version ?? 0 : 0}>
        ${branch ? html`
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-700/50 px-4 py-2">
            ${baseBranch && baseBranch !== branch ? html`
              <span class="text-xs font-mono text-zinc-500">${baseBranch}</span>
              <span class="text-xs text-zinc-600">←</span>
            ` : nothing}
            <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
              ${branchIcon("shrink-0 text-zinc-500", 12)}
              ${branch}
            </span>
          </div>
        ` : nothing}
        <div
          class="min-h-0 flex-1 overflow-y-auto"
          data-review-scroll
          @scroll=${this._handleScroll}
        >
          ${loading
            ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">Loading Reins diff…</div>`
            : data?.parseError
              ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Unable to parse patch: ${data.parseError}</div>`
              : items.length > 0
                ? html`<div
                    data-review-virtual-window
                    style=${`padding-top:${virtualWindow.paddingTop}px;padding-bottom:${virtualWindow.paddingBottom}px`}
                  >${mountedItems.map((item) => html`
                    <review-diff-item
                      data-review-item-id=${item.id}
                      data-file-path=${item.path}
                      ?data-review-first=${item === items[0]}
                      .item=${item}
                      .collapsed=${this.isItemCollapsed(item.id)}
                      .projectId=${this.store?.projectId ?? null}
                      .branch=${branch ?? null}
                      @toggle-collapse=${this._handleToggleCollapse}
                      @diff-rendered=${this._handleDiffRendered}
                    ></review-diff-item>
                  `)}</div>`
                : html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">No changes yet</div>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-diff-panel": ReviewDiffPanel;
  }
}
