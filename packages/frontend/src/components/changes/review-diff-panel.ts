import { FileDiff, type FileDiffOptions } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { getPierreWorkerPool, PIERRE_SHIKI_THEME } from "../../models/changes/pierre-worker-pool.js";
import { ScrollSpy } from "../../models/changes/scroll-spy.js";
import {
  parseReviewItems,
  reconcileReviewItems,
  type ReviewItem,
  type ReviewItemsResult,
} from "../../models/changes/review-items.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import { branchIcon, changedFileStatusIcon } from "../icons.js";
import "./diff-file-action-buttons.js";

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

const REINS_DIFF_OPTIONS: FileDiffOptions<undefined> = {
  theme: PIERRE_SHIKI_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  hunkSeparators: "line-info",
  disableFileHeader: true,
};

type PierreFileDiffRenderer = Pick<FileDiff<undefined>, "render" | "cleanUp">;
type PierreFileDiffFactory = () => PierreFileDiffRenderer;

@customElement("review-diff-item")
export class ReviewDiffItem extends LitElement {
  private _createFileDiff: PierreFileDiffFactory;

  constructor(createFileDiff: PierreFileDiffFactory = () => new FileDiff(REINS_DIFF_OPTIONS, getPierreWorkerPool(), true)) {
    super();
    this._createFileDiff = createFileDiff;
  }

  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) item: ReviewItem | null = null;
  @property({ type: Number, attribute: false }) projectId: number | null = null;
  @property({ attribute: false }) branch: string | null = null;

  private _fileDiff: PierreFileDiffRenderer | null = null;
  private _renderedItem: ReviewItem | null = null;
  private _root: HTMLElement | null = null;

  override updated() {
    this._syncFileDiff();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyFileDiff();
  }

  protected getDiffRoot(): HTMLElement | null {
    return this.querySelector<HTMLElement>("[data-pierre-file-diff]");
  }

  private _syncFileDiff() {
    const root = this.getDiffRoot();
    if (!root || !this.item) {
      this._destroyFileDiff();
      return;
    }
    if (this._fileDiff && this._root === root) {
      if (this._renderedItem === this.item) return;
      this._renderedItem = this.item;
      this._fileDiff.render({ fileDiff: this.item.fileDiff, fileContainer: root });
      return;
    }

    this._destroyFileDiff();
    this._fileDiff = this._createFileDiff();
    this._root = root;
    this._renderedItem = this.item;
    this._fileDiff.render({ fileDiff: this.item.fileDiff, fileContainer: root });
  }

  private _destroyFileDiff() {
    this._fileDiff?.cleanUp();
    this._fileDiff = null;
    this._root = null;
    this._renderedItem = null;
  }

  private _fileUrl(path: string): string {
    if (this.projectId == null) return "";
    let url = `/api/projects/${this.projectId}/files/content?path=${encodeURIComponent(path)}`;
    if (this.branch) url += `&ref=${encodeURIComponent(this.branch)}`;
    return url;
  }

  override render() {
    const item = this.item;
    if (!item) return nothing;

    return html`
      <article class="border-b border-zinc-700/70 bg-zinc-950">
        <header class="reins-diff-header sticky top-0 z-10 flex min-w-0 items-center gap-2 px-3 py-2">
          ${changedFileStatusIcon(item.status)}
          ${item.oldPath && item.oldPath !== item.path
            ? html`
                <span class="reins-diff-path min-w-0 truncate font-mono text-sm text-zinc-500" title=${item.oldPath}>
                  <bdi>${item.oldPath}</bdi>
                </span>
                <span class="shrink-0 text-xs text-zinc-500" aria-hidden="true">→</span>
              `
            : nothing}
          <span class="reins-diff-path min-w-0 flex-1 truncate font-mono text-sm text-zinc-200" title=${item.path}>
            <bdi>${item.path}</bdi>
          </span>
          ${item.additions > 0 || item.removals > 0
            ? html`
                <span class="flex shrink-0 items-center gap-2 font-mono text-xs">
                  ${item.additions > 0 ? html`<span class="text-green-400">+${item.additions}</span>` : nothing}
                  ${item.removals > 0 ? html`<span class="text-red-400">-${item.removals}</span>` : nothing}
                </span>
              `
            : nothing}
          <span class="flex shrink-0 items-center gap-1">
            <diff-view-file-button .path=${item.path} variant="header"></diff-view-file-button>
            <diff-copy-path-button .path=${item.path} variant="header"></diff-copy-path-button>
            <diff-download-file-button
              .path=${item.path}
              .href=${this._fileUrl(item.path)}
              variant="header"
            ></diff-download-file-button>
          </span>
        </header>
        <diffs-container data-pierre-file-diff></diffs-container>
      </article>
    `;
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
  private _pendingItemId: string | null = null;
  private _parsedSource: DiffPatchData | null = null;
  private _parsedData: ReviewItemsResult | null = null;
  private _scrollPosition = new ReviewScrollPosition();
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
    const itemId = this.itemIdForPath(path);
    if (!itemId) {
      this._pendingPath = path;
      return;
    }
    this._pendingPath = null;
    this.scrollToItem(itemId);
  }

  public scrollToItem(id: string) {
    const item = this.querySelector<HTMLElement>(`[data-review-item-id="${CSS.escape(id)}"]`);
    if (!item) {
      this._pendingItemId = id;
      return;
    }

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
    this._pendingItemId = null;
    this.reportActiveItem(id);
  }

  public reportActiveItem(id: string) {
    const item = this._parsedData?.items.find((candidate) => candidate.id === id);
    if (!item || this._activeItemId === id) return;
    this._activeItemId = id;

    this.dispatchEvent(new CustomEvent<string>("active-item-change", {
      detail: id,
      bubbles: true,
      composed: true,
    }));
    this.dispatchEvent(new CustomEvent<string>("active-file-change", {
      detail: item.path,
      bubbles: true,
      composed: true,
    }));
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

  private _handleScroll(event: Event) {
    if (event.currentTarget instanceof HTMLElement) {
      this._scrollPosition.remember(event.currentTarget, this.visible);
    }
  }

  private _syncPendingScroll() {
    if (this._pendingPath) {
      const path = this._pendingPath;
      const itemId = this.itemIdForPath(path);
      if (itemId) {
        this._pendingPath = null;
        this._pendingItemId = itemId;
      }
    }
    if (!this._pendingItemId) return;
    const id = this._pendingItemId;
    requestAnimationFrame(() => this.scrollToItem(id));
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
                        .projectId=${this.store?.projectId ?? null}
                        .branch=${branch ?? null}
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
    "review-diff-item": ReviewDiffItem;
    "review-diff-panel": ReviewDiffPanel;
  }
}
