import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ReviewCollapseState,
  type ReviewCollapseScope,
} from "../../models/changes/review-collapse-state.js";
import { ScrollSpy } from "../../models/changes/scroll-spy.js";
import {
  parseReviewItems,
  reconcileReviewItems,
  type ReviewItemsResult,
} from "../../models/changes/review-items.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import { activeFileChangeEvent, activeItemChangeEvent } from "../events.js";
import { branchIcon } from "../icons.js";
import { ReviewDiffItem } from "./review-diff-item.js";

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

/**
 * Reins-owned renderer scaffold. It intentionally mounts every review item;
 * this is a functional boundary for a later top-level virtual list, not a
 * performance solution.
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
  private _scrollSpy = new ScrollSpy({
    containerSelector: "[data-review-scroll]",
    itemSelector: "[data-review-item-id]",
    dataAttribute: "reviewItemId",
    onActiveChange: (id) => this.reportActiveItem(id),
  });

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
    this._scrollSpy.update(this);
    const data = this._parsedData;
    if (!this._activeItemId && data?.items[0]) this.reportActiveItem(data.items[0].id);
    this._syncPendingScroll();
    if (changed.has("visible") && this.visible) {
      const container = this.querySelector<HTMLElement>("[data-review-scroll]");
      if (container) this._scrollPosition.restore(container, true);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._scrollSpy.destroy();
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
    if (this.isItemCollapsed(itemId)) {
      this.setItemCollapsed(itemId, false);
      return;
    }
    if (!this._itemsBeforeRendered(itemId)) return;

    const item = this.querySelector<HTMLElement>(`[data-review-item-id="${CSS.escape(itemId)}"]`);
    if (!item) return;

    const container = this.querySelector<HTMLElement>("[data-review-scroll]");
    if (container && typeof container.scrollTo === "function") {
      const itemRect = item.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + itemRect.top - containerRect.top,
        behavior: "smooth",
      });
    } else {
      item.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
    this._collapseState.setCollapsed(scope, item, collapsed);
    this.requestUpdate();
  }

  private _handleDiffRendered() {
    this._syncPendingScroll();
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

  private _itemsBeforeRendered(id: string): boolean {
    for (const item of this._parsedData?.items ?? []) {
      if (item.id === id) return true;
      if (this.isItemCollapsed(item.id)) continue;
      const element = this.querySelector(
        `[data-review-item-id="${CSS.escape(item.id)}"]`,
      );
      if (!(element instanceof ReviewDiffItem) || !element.diffRendered) return false;
    }
    return false;
  }

  private _handleScroll(event: Event) {
    if (event.currentTarget instanceof HTMLElement) {
      this._scrollPosition.remember(event.currentTarget, this.visible);
    }
  }

  private _handleToggleCollapse(event: CustomEvent<string>) {
    const id = event.detail;
    this.setItemCollapsed(id, !this.isItemCollapsed(id));
  }

  private _syncPendingScroll() {
    if (this.store?.patchData.loading || !this._pendingPath) return;

    const path = this._pendingPath;
    const itemId = this.itemIdForPath(path);
    if (!itemId || !this._itemsBeforeRendered(itemId)) return;
    requestAnimationFrame(() => this.scrollToFile(path));
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
                ? repeat(
                    items,
                    (item) => item.id,
                    (item) => html`
                      <review-diff-item
                        data-review-item-id=${item.id}
                        data-file-path=${item.path}
                        .item=${item}
                        .collapsed=${this.isItemCollapsed(item.id)}
                        .projectId=${this.store?.projectId ?? null}
                        .branch=${branch ?? null}
                        @toggle-collapse=${this._handleToggleCollapse}
                        @diff-rendered=${this._handleDiffRendered}
                      ></review-diff-item>
                    `,
                  )
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
