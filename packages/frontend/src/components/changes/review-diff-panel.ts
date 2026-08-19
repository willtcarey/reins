import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ReviewCollapseState,
  reviewContentFingerprint,
  type ReviewCollapseScope,
} from "../../models/changes/review-collapse-state.js";
import {
  parseReviewItems,
  reconcileReviewItems,
  type ReviewItem,
  type ReviewItemsResult,
} from "../../models/changes/review-items.js";
import {
  estimateReviewItemHeight,
  reviewItemGap,
  ReviewVirtualCoordinator,
  type ReviewVirtualGeometryUpdate,
  type ReviewVirtualMeasurement,
} from "../../models/changes/review-virtual-layout.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import { activeFileChangeEvent, activeItemChangeEvent } from "../events.js";
import { branchIcon } from "../icons.js";
import { ReviewDiffItem } from "./review-diff-item.js";

const DEFAULT_VIEWPORT_HEIGHT = 800;
const REVIEW_ITEM_OVERSCAN = 600;

type ScrollPositionContainer = Pick<HTMLElement, "scrollTop" | "clientHeight">;

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

/** Reins-owned review renderer backed by one persistent top-level coordinator. */
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
    this._coordinator = new ReviewVirtualCoordinator(REVIEW_ITEM_OVERSCAN);
    this._coordinator.setViewport(0, this._viewportHeight);
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
  private _coordinator = new ReviewVirtualCoordinator(REVIEW_ITEM_OVERSCAN);
  private _resizeObserver: ResizeObserver | null = null;
  private _viewportHeight = DEFAULT_VIEWPORT_HEIGHT;
  private _renderFrame: number | null = null;
  private _pendingGeometryScrollTop: number | null = null;
  private _navigationItemId: string | null = null;

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
    this._applyPendingGeometryScroll();
    this._observeGeometry();
    const data = this._parsedData;
    if (!this._activeItemId && data?.items[0]) this.reportActiveItem(data.items[0].id);
    this._syncPendingScroll();
    if (changed.has("visible") && this.visible) {
      const container = this._scrollContainer();
      if (container && this._scrollPosition.restore(container, true)) {
        this._coordinator.setViewport(container.scrollTop, container.clientHeight || this._viewportHeight);
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

    const top = this._coordinator.navigationTop(itemId);
    const container = this._scrollContainer();
    if (top === null || !container) return;

    this._navigationItemId = itemId;
    container.scrollTo({ top, behavior: "smooth" });
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

    this._syncViewportFromContainer();
    this._collapseState.setCollapsed(scope, item, collapsed);
    this._queueGeometryUpdate(this._syncCoordinatorItems(), true);
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
    this._navigationItemId = null;
  }

  private _reconcilePatchData() {
    const source = this.store?.patchData.data ?? null;
    if (!source) {
      if (this._parsedSource || this._parsedData) {
        this._resetParsedData();
        this._queueGeometryUpdate(this._syncCoordinatorItems(), true);
      }
      return;
    }
    if (source === this._parsedSource) return;

    this._parsedSource = source;
    this._parsedData = reconcileReviewItems(
      this._parsedData,
      parseReviewItems(source.patch, source.cacheKeyPrefix),
    );
    if (this._activeItemId && !this._parsedData.items.some((item) => item.id === this._activeItemId)) {
      this._activeItemId = null;
    }
    this._queueGeometryUpdate(this._syncCoordinatorItems(), true);
  }

  private _collapseScope(): ReviewCollapseScope | null {
    const store = this.store;
    if (store?.projectId == null) return null;
    return { projectId: store.projectId, branch: this._parsedSource?.branch ?? store.branch };
  }

  private _measurementKey(item: ReviewItem): string {
    const scope = this._collapseScope();
    const state = this.isItemCollapsed(item.id) ? "collapsed" : "expanded";
    return `${scope?.projectId ?? "none"}:${scope?.branch ?? "none"}:${item.id}:${reviewContentFingerprint(item.contentKey)}:${state}`;
  }

  private _syncCoordinatorItems(): ReviewVirtualGeometryUpdate {
    return this._coordinator.setItems((this._parsedData?.items ?? []).map((item, index) => ({
      id: item.id,
      measurementKey: this._measurementKey(item),
      estimatedHeight: estimateReviewItemHeight(item, this.isItemCollapsed(item.id), index),
    })));
  }

  private _scrollContainer(): HTMLElement | null {
    if (typeof this.querySelector !== "function") return null;
    return this.querySelector<HTMLElement>("[data-review-scroll]");
  }

  private _syncViewportFromContainer() {
    const container = this._scrollContainer();
    if (!container) return;
    this._coordinator.setViewport(container.scrollTop, container.clientHeight || this._viewportHeight);
  }

  private _handleScroll(event: Event) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const container = event.currentTarget;
    if (container.clientHeight > 0) this._viewportHeight = container.clientHeight;
    this._coordinator.setViewport(container.scrollTop, this._viewportHeight);
    this._scrollPosition.remember(container, this.visible);
    const activeId = this._coordinator.window().activeId;
    if (activeId) this.reportActiveItem(activeId);
    if (this._navigationItemId === activeId) this._navigationItemId = null;
    this._scheduleRender();
  }

  private _cancelProgrammaticScroll(event: Event) {
    if (!this._navigationItemId || !this._isScrollIntent(event)) return;
    this._navigationItemId = null;
    const container = this._scrollContainer();
    if (container) container.scrollTo({ top: container.scrollTop, behavior: "auto" });
  }

  private _isScrollIntent(event: Event): boolean {
    if (event.type !== "keydown") return true;
    return event instanceof KeyboardEvent
      && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
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
    this.setItemCollapsed(event.detail, !this.isItemCollapsed(event.detail));
  }

  private _handleDiffRendered(event: Event) {
    if (event.target instanceof HTMLElement) this._recordMeasurements([event.target]);
    this._syncPendingScroll();
  }

  private _syncPendingScroll() {
    if (this.store?.patchData.loading || !this._pendingPath || !this._scrollContainer()) return;
    const path = this._pendingPath;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => this.scrollToFile(path));
    else setTimeout(() => this.scrollToFile(path), 0);
  }

  private _observeGeometry() {
    if (typeof ResizeObserver === "undefined") return;
    this._resizeObserver ??= new ResizeObserver((entries) => {
      const measuredItems: HTMLElement[] = [];
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        if (entry.target.hasAttribute("data-review-scroll")) {
          if (entry.contentRect.height > 0 && entry.contentRect.height !== this._viewportHeight) {
            this._viewportHeight = entry.contentRect.height;
            const container = this._scrollContainer();
            this._coordinator.setViewport(container?.scrollTop ?? 0, this._viewportHeight);
            this.requestUpdate();
          }
        } else if (entry.target.hasAttribute("data-review-item-id")) measuredItems.push(entry.target);
      }
      this._recordMeasurements(measuredItems);
    });

    this._resizeObserver.disconnect();
    const container = this._scrollContainer();
    if (container) this._resizeObserver.observe(container);
    if (typeof this.querySelectorAll !== "function") return;
    for (const item of this.querySelectorAll<HTMLElement>("[data-review-item-id]")) this._resizeObserver.observe(item);
  }

  private _recordMeasurements(elements: readonly HTMLElement[]) {
    this._syncViewportFromContainer();
    const measurements: ReviewVirtualMeasurement[] = [];
    for (const element of elements) {
      const id = element.dataset.reviewItemId;
      const item = this._parsedData?.items.find((candidate) => candidate.id === id);
      if (!item) continue;
      const height = element.getBoundingClientRect().height || element.offsetHeight;
      const stable = element instanceof ReviewDiffItem ? element.measurementStable : false;
      measurements.push({ id: item.id, measurementKey: this._measurementKey(item), height, stable });
    }
    const update = this._coordinator.measure(measurements);
    this._queueGeometryUpdate(update, update.accepted > 0);
  }

  private _queueGeometryUpdate(update: ReviewVirtualGeometryUpdate, geometryChanged = false) {
    if (this._navigationItemId && geometryChanged) {
      this._pendingGeometryScrollTop = this._coordinator.navigationTop(this._navigationItemId);
    } else if (update.scrollAdjustment !== 0) {
      this._pendingGeometryScrollTop = update.scrollTop;
    } else {
      return;
    }
    this.requestUpdate();
  }

  private _applyPendingGeometryScroll() {
    if (this._pendingGeometryScrollTop === null) return;
    const top = this._pendingGeometryScrollTop;
    this._pendingGeometryScrollTop = null;
    const container = this._scrollContainer();
    if (!container) return;
    if (this._navigationItemId) container.scrollTo({ top, behavior: "smooth" });
    else container.scrollTop = top;
    this._coordinator.setViewport(top, container.clientHeight || this._viewportHeight);
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
    const virtualWindow = this._coordinator.window();
    const itemById = new Map(items.map((item, index) => [item.id, { item, index }]));

    return html`
      <div class="flex h-full min-h-0 flex-col" data-rendered-payload-version=${data ? this.store.patchData.data?.version ?? 0 : 0}>
        ${branch ? html`
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-700/50 px-4 py-2">
            ${baseBranch && baseBranch !== branch ? html`
              <span class="text-xs font-mono text-zinc-500">${baseBranch}</span><span class="text-xs text-zinc-600">←</span>
            ` : nothing}
            <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
              ${branchIcon("shrink-0 text-zinc-500", 12)}${branch}
            </span>
          </div>
        ` : nothing}
        <div
          class="min-h-0 flex-1 overflow-y-auto"
          data-review-scroll
          @scroll=${this._handleScroll}
          @wheel=${this._cancelProgrammaticScroll}
          @touchstart=${this._cancelProgrammaticScroll}
          @pointerdown=${this._cancelProgrammaticScroll}
          @keydown=${this._cancelProgrammaticScroll}
        >
          ${loading
            ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">Loading Reins diff…</div>`
            : data?.parseError
              ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Unable to parse patch: ${data.parseError}</div>`
              : items.length > 0
                ? html`<div data-review-virtual-window style=${`position:relative;height:${virtualWindow.totalHeight}px`}>
                    ${repeat(
                      virtualWindow.items,
                      (entry) => entry.id,
                      (entry) => {
                        const record = itemById.get(entry.id);
                        if (!record) return nothing;
                        const { item, index } = record;
                        return html`
                          <review-diff-item
                            style=${`position:absolute;top:${entry.top}px;left:0;right:0`}
                            data-review-item-id=${item.id}
                            data-file-path=${item.path}
                            ?data-review-first=${item === items[0]}
                            .item=${item}
                            .collapsed=${this.isItemCollapsed(item.id)}
                            .projectId=${this.store?.projectId ?? null}
                            .branch=${branch ?? null}
                            .reservedHeight=${Math.max(1, entry.height - reviewItemGap(index))}
                            @toggle-collapse=${this._handleToggleCollapse}
                            @diff-rendered=${this._handleDiffRendered}
                          ></review-diff-item>
                        `;
                      },
                    )}
                  </div>`
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
