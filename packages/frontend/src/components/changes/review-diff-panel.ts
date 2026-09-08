import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { InlineReviewController } from "../../controllers/inline-review-controller.js";
import {
  VirtualListController,
  type VirtualListObservation,
} from "../../controllers/virtual-list-controller.js";
import {
  ReviewCollapseState,
  type ReviewCollapseScope,
} from "../../models/changes/review-collapse-state.js";
import { FileDiffContextState } from "../../models/changes/file-diff-context-state.js";
import type { FileDiffContextScope } from "../../models/changes/file-contents.js";
import {
  parseFileChanges,
  reconcileFileChanges,
  type FileChange,
  type FileChangesResult,
} from "../../models/changes/file-changes.js";
import type { ReviewSide } from "../../models/code-review.js";
import { reviewDiffLines } from "../../models/changes/review-diff-anchor.js";
import {
  estimateFileChangeHeight,
  fileChangeGap,
} from "../../models/changes/review-virtual-layout.js";
import {
  clientTelemetry,
  type ClientTelemetryOperation,
} from "../../models/client-telemetry.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import type { CodeReviewStore } from "../../models/stores/code-review-store.js";
import {
  activeFileChangeEvent,
  activeItemChangeEvent,
} from "../events.js";
import { branchIcon, conversationIcon } from "../icons.js";
import type { ReviewFileDiffHeightChange } from "./review-file-diff.js";
import type { ReviewFileExpansionInteraction } from "./review-file-diff-renderer.js";
import "./review-file-diff.js";

const DEFAULT_VIEWPORT_HEIGHT = 800;
const REVIEW_ITEM_OVERSCAN = 600;

/** Review-specific adapter around the generic top-level virtual list behavior. */
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
    this._virtualList.reset();
    this._resetParsedData();
    this._reconcilePatchData();
    this.requestUpdate("store", oldValue);
  }

  private _reviewStore: CodeReviewStore | null = null;

  @property({ attribute: false })
  get reviewStore(): CodeReviewStore | null {
    return this._reviewStore;
  }

  set reviewStore(value: CodeReviewStore | null) {
    const oldValue = this._reviewStore;
    if (value === oldValue) return;
    this._unsubscribeReview?.();
    this._unsubscribeReview = null;
    this._reviewStore = value;
    this._inlineReview.setReview(value?.review ?? null);
    this._subscribeReview();
    this._reconcilePatchData(true);
    this.requestUpdate("reviewStore", oldValue);
  }

  @property({ type: Boolean }) visible = false;
  @property() sessionId = "";
  @property({ type: Boolean }) sessionRunning = false;

  private _unsubscribe: (() => void) | null = null;
  private _pendingPath: string | null = null;
  private _parsedSource: DiffPatchData | null = null;
  private _parsedData: FileChangesResult | null = null;
  private _collapseState = new ReviewCollapseState();
  private _virtualList = new VirtualListController(
    this,
    REVIEW_ITEM_OVERSCAN,
    DEFAULT_VIEWPORT_HEIGHT,
  );
  private _navigationTelemetry: ClientTelemetryOperation | null = null;
  private _contextState: FileDiffContextState | null = null;
  private _contextScopeKey = "";
  private _transitionHeights = new Map<string, number>();
  private _unsubscribeReview: (() => void) | null = null;
  private _inlineReview = new InlineReviewController(
    this,
    async (comment) => {
      if (!this.reviewStore) throw new Error("Code review comments are unavailable.");
      return this.reviewStore.addComment(comment);
    },
    async (commentId) => {
      if (!this.reviewStore) throw new Error("Code review comments are unavailable.");
      await this.reviewStore.deleteComment(commentId);
    },
  );
  private readonly _expandFileContext = (
    change: FileChange,
    interaction: ReviewFileExpansionInteraction,
    mutate: () => void,
    resolveAnchor: () => number | null,
  ) => {
    if (interaction.direction === "up") {
      mutate();
      return;
    }
    const anchor = interaction.direction === "down" ? "item-end" : resolveAnchor;
    this._virtualList.preserveScroll(change.id, anchor, mutate);
  };
  private readonly _toggleFileCollapse = (id: string) => {
    this.setItemCollapsed(id, !this.isItemCollapsed(id));
  };
  private readonly _handleCommentLayoutChange = (
    change: FileChange,
    resolveAnchor: () => number | null,
  ) => {
    this._virtualList.preserveScroll(change.id, resolveAnchor, () => {});
  };

  constructor() {
    super();
    this._virtualList.observe = (observation) => this._observeVirtualList(observation);
    this._inlineReview.onLayoutChange = () => this._syncVirtualItems();
  }

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
    this._subscribeReview();
  }

  override willUpdate(changed: Map<string, unknown>) {
    const storeChanged = changed.has("store");
    if (storeChanged) this._subscribe();
    if (changed.has("visible")) this._virtualList.setVisible(this.visible);
    this._reconcilePatchData();
    if (this.visible && (storeChanged || changed.has("visible"))) this._fetchFresh();
  }

  override updated() {
    this._virtualList.attach(this._scrollContainer());
    const activeId = this._virtualList.window().activeId;
    if (activeId) this.reportActiveItem(activeId);
    this._syncPendingScroll();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubscribeReview?.();
    this._unsubscribeReview = null;
    this._navigationTelemetry = null;
    this.store?.clearPatchDiff();
  }

  public itemIdForPath(path: string): string | null {
    return this._parsedData?.pathToChangeId.get(path) ?? null;
  }

  public scrollToFile(path: string) {
    this._pendingPath = path;
    if (this.store?.patchData.loading) return;

    const itemId = this.itemIdForPath(path);
    if (!itemId) return;
    if (this.isItemCollapsed(itemId)) this.setItemCollapsed(itemId, false);

    this._virtualList.attach(this._scrollContainer());
    if (!this._virtualList.navigateTo(itemId)) return;
    this._pendingPath = null;
    this.reportActiveItem(itemId);
  }

  public isItemCollapsed(id: string): boolean {
    const change = this._parsedData?.changes.find((candidate) => candidate.id === id);
    const scope = this._collapseScope();
    return change && scope ? this._collapseState.isCollapsed(scope, change) : false;
  }

  public setItemCollapsed(id: string, collapsed: boolean) {
    const change = this._parsedData?.changes.find((candidate) => candidate.id === id);
    const scope = this._collapseScope();
    if (!change || !scope || this.isItemCollapsed(id) === collapsed) return;

    const scroll = this._scrollContainer();
    this._virtualList.attach(scroll);
    const geometry = this._virtualList.item(id);
    const returnToHeader = collapsed
      && scroll !== null
      && geometry !== undefined
      && scroll.scrollTop > geometry.top
      && scroll.scrollTop < geometry.top + geometry.height;

    if (geometry) this._transitionHeights.set(id, geometry.height - geometry.gapBefore);
    else this._transitionHeights.delete(id);
    this._collapseState.setCollapsed(scope, change, collapsed);
    this._syncVirtualItems();
    if (returnToHeader) this._virtualList.scrollToItemStart(id);
    this.requestUpdate();
  }

  public reportActiveItem(id: string) {
    const change = this._parsedData?.changes.find((candidate) => candidate.id === id);
    if (!change || this._activeItemId === id) return;
    this._activeItemId = id;
    this.dispatchEvent(activeItemChangeEvent(id));
    this.dispatchEvent(activeFileChangeEvent(change.path));
  }

  private _subscribeReview() {
    if (this._unsubscribeReview || !this.reviewStore || !this.isConnected) return;
    this._unsubscribeReview = this.reviewStore.subscribe(() => {
      this._inlineReview.setReview(this.reviewStore?.review ?? null);
      this.requestUpdate();
    });
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

  private async _submitReview() {
    if (!this.reviewStore || !this.sessionId) return;
    const submission = this.reviewStore.submit(this.sessionId);
    this.requestUpdate();
    try {
      await submission;
    } catch {
      // The store exposes the user-facing error beside the action.
    } finally {
      this.requestUpdate();
    }
  }

  private _resetParsedData() {
    this._parsedSource = null;
    this._parsedData = null;
    this._activeItemId = null;
    this._navigationTelemetry = null;
    this._contextState = null;
    this._contextScopeKey = "";
    this._transitionHeights.clear();
    this._inlineReview.clear();
  }

  private _reconcilePatchData(force = false) {
    const source = this.store?.patchData.data ?? null;
    if (!source) {
      if (this._parsedSource || this._parsedData) {
        this._resetParsedData();
        this._syncVirtualItems();
      }
      return;
    }
    if (source === this._parsedSource && !force) return;

    this._parsedSource = source;
    this._parsedData = reconcileFileChanges(
      this._parsedData,
      parseFileChanges(source.patch, source.cacheKeyPrefix),
    );
    if (this._activeItemId && !this._parsedData.changes.some((change) => change.id === this._activeItemId)) {
      this._activeItemId = null;
    }
    this._ensureContextState();
    const store = this.store;
    this._inlineReview.reconcile(
      `${store?.projectId ?? "none"}:${store?.diffMode ?? "branch"}:${source.branch ?? store?.branch ?? ""}`,
      this._parsedData.changes.map((change) => ({
        id: change.id,
        contentKey: change.contentKey,
        path: change.path,
        oldPath: change.oldPath,
        filePatch: change.filePatch,
        diffLines: (side: ReviewSide) => reviewDiffLines(change.fileDiff, side),
      })),
    );
    this._syncVirtualItems();
  }

  private _ensureContextState(): FileDiffContextState | null {
    const store = this.store;
    if (store?.projectId == null) return null;
    const scope: FileDiffContextScope = {
      projectId: store.projectId,
      mode: store.diffMode,
      branch: this._parsedSource?.branch ?? store.branch,
    };
    const key = `${scope.projectId}:${scope.mode}:${scope.branch ?? ""}`;
    if (key === this._contextScopeKey && this._contextState) return this._contextState;

    this._contextScopeKey = key;
    this._contextState = new FileDiffContextState(scope);
    return this._contextState;
  }

  private _collapseScope(): ReviewCollapseScope | null {
    const store = this.store;
    if (store?.projectId == null) return null;
    return { projectId: store.projectId, branch: this._parsedSource?.branch ?? store.branch };
  }

  private _measurementKey(change: FileChange): string {
    const scope = this._collapseScope();
    const commentRevision = this._inlineReview.file(change.id).layoutRevision;
    return `${scope?.projectId ?? "none"}:${scope?.branch ?? "none"}:${change.id}:${change.contentKey}:comments-${commentRevision}`;
  }

  private _syncVirtualItems() {
    const scope = this._collapseScope();
    this._virtualList.setItems((this._parsedData?.changes ?? []).map((change, index) => {
      const collapsed = scope ? this._collapseState.isCollapsed(scope, change) : false;
      return {
        id: change.id,
        measurementKey: this._measurementKey(change),
        estimatedHeight: estimateFileChangeHeight(change, false),
        gapBefore: fileChangeGap(index),
        fixedHeight: this._transitionHeights.get(change.id)
          ?? (collapsed ? estimateFileChangeHeight(change, true) : undefined),
      };
    }));
  }

  private _scrollContainer(): HTMLElement | null {
    if (typeof this.querySelector !== "function") return null;
    return this.querySelector<HTMLElement>("[data-review-scroll]");
  }

  private readonly _handleFileHeightChange = (source: FileChange, update: ReviewFileDiffHeightChange) => {
    const index = this._parsedData?.changes.findIndex((change) => change.id === source.id) ?? -1;
    const change = index >= 0 ? this._parsedData?.changes[index] : undefined;
    if (!change) {
      this._transitionHeights.delete(source.id);
      return;
    }

    if (update.kind === "measurement") {
      if (this.isItemCollapsed(change.id)) return;
      this._virtualList.measure({
        id: change.id,
        measurementKey: this._measurementKey(change),
        height: update.height,
      });
      return;
    }

    if (update.settled) {
      this._transitionHeights.delete(change.id);
      this._syncVirtualItems();
      this.requestUpdate();
      return;
    }

    const collapsedHeight = estimateFileChangeHeight(change, true);
    const transitionHeight = collapsedHeight + update.bodyHeight;
    this._transitionHeights.set(change.id, transitionHeight);
    this._virtualList.setItemFixedHeight(change.id, transitionHeight);
  };

  private _syncPendingScroll() {
    if (this.store?.patchData.loading || !this._pendingPath || !this._scrollContainer()) return;
    const path = this._pendingPath;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => this.scrollToFile(path));
    else setTimeout(() => this.scrollToFile(path), 0);
  }

  private _observeVirtualList(observation: VirtualListObservation) {
    switch (observation.type) {
      case "navigation-start":
        this._navigationTelemetry = clientTelemetry.startOperation("review-virtualizer");
        this._recordTelemetry(observation.type, {
          targetIndex: this._itemIndex(observation.targetId),
          requestedTop: observation.requestedTop,
          actualTop: observation.actualTop,
          replacedCorrection: observation.replacedCorrection,
          layoutVersion: observation.layoutVersion,
        });
        break;
      case "scroll":
        this._recordTelemetry(observation.type, {
          actualTop: observation.actualTop,
          activeIndex: this._itemIndex(observation.activeId),
          navigationIndex: this._itemIndex(observation.navigationId),
          layoutVersion: observation.layoutVersion,
        });
        if (observation.activeId) this.reportActiveItem(observation.activeId);
        break;
      case "navigation-cancelled":
      case "navigation-complete":
        this._recordTelemetry(observation.type, {
          inputType: observation.inputType,
          actualTop: observation.actualTop,
          navigationIndex: this._itemIndex(observation.targetId),
          layoutVersion: observation.layoutVersion,
        });
        this._navigationTelemetry = null;
        break;
      case "measurement-rejected":
        this._recordTelemetry(observation.type, {
          index: this._itemIndex(observation.measurement.id),
          measuredHeight: Math.round(observation.measurement.height),
          itemHeight: observation.itemHeight === null ? null : Math.round(observation.itemHeight),
          reason: observation.reason,
          layoutVersion: observation.layoutVersion,
        });
        break;
      case "measurement-batch":
        this._recordTelemetry(observation.type, {
          submitted: observation.submitted,
          accepted: observation.accepted,
          correctedTop: observation.correctedTop,
          scrollAdjustment: observation.scrollAdjustment,
          actualTop: observation.actualTop,
          layoutVersion: observation.layoutVersion,
          candidates: observation.measurements.map((measurement) => ({
            index: this._itemIndex(measurement.id),
            measuredHeight: Math.round(measurement.height),
            stable: true,
          })),
        });
        this._syncPendingScroll();
        break;
      case "geometry-queued":
        this._recordTelemetry(observation.type, {
          reason: observation.reason,
          requestedTop: observation.requestedTop,
          actualTop: observation.actualTop,
          navigationIndex: this._itemIndex(observation.navigationId),
          layoutVersion: observation.layoutVersion,
        });
        break;
      case "geometry-applied":
        this._recordTelemetry(observation.type, {
          requestedTop: observation.requestedTop,
          actualBefore: observation.actualBefore,
          actualAfter: observation.actualAfter,
          smooth: observation.smooth,
          navigationIndex: this._itemIndex(observation.navigationId),
          layoutVersion: observation.layoutVersion,
        });
        break;
      case "window-change": {
        const firstIndex = this._itemIndex(observation.window.items[0]?.id ?? null);
        const lastIndex = this._itemIndex(observation.window.items.at(-1)?.id ?? null);
        this._recordTelemetry(observation.type, {
          firstIndex,
          lastIndex,
          mountedCount: observation.window.items.length,
          totalHeight: observation.window.totalHeight,
          actualTop: observation.actualTop,
          layoutVersion: observation.layoutVersion,
        });
        break;
      }
    }
  }

  private _recordTelemetry(
    event: string,
    attributes: Record<string, unknown> | (() => Record<string, unknown>),
  ) {
    if (this._navigationTelemetry) this._navigationTelemetry.record(event, attributes);
    else clientTelemetry.record("review-virtualizer", event, attributes);
  }

  private _itemIndex(id: string | null): number | null {
    if (!id) return null;
    const index = this._parsedData?.changes.findIndex((change) => change.id === id) ?? -1;
    return index >= 0 ? index : null;
  }

  override render() {
    if (!this.store) return nothing;
    if (this.store.patchData.error) {
      return html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Error: ${this.store.patchData.error}</div>`;
    }

    const loading = this.store.patchData.loading && !this.store.patchData.data;
    const data = this._parsedData;
    const changes = data?.changes ?? [];
    const branch = this._parsedSource?.branch ?? this.store.branch;
    const baseBranch = this._parsedSource?.baseBranch ?? this.store.fileData.data?.baseBranch;
    const virtualWindow = this._virtualList.window();
    const pinnedComposerId = this._inlineReview.activeComposerFileId;
    const pinnedComposer = pinnedComposerId && !virtualWindow.items.some((entry) => entry.id === pinnedComposerId)
      ? this._virtualList.item(pinnedComposerId)
      : null;
    const mountedItems = [
      ...virtualWindow.items,
      ...(pinnedComposer ? [pinnedComposer] : []),
    ].toSorted((left, right) => left.top - right.top);
    const changeById = new Map(changes.map((change) => [change.id, change]));
    const activeReview = this.reviewStore?.review;
    const hasSavedComments = (activeReview?.annotations.length ?? 0) > 0;
    const canSubmit = hasSavedComments
      && !this.reviewStore?.submitting
      && !this.sessionRunning
      && this.sessionId.length > 0;

    return html`
      <div class="relative flex h-full min-h-0 flex-col" data-rendered-payload-version=${data ? this.store.patchData.data?.version ?? 0 : 0}>
        ${branch ? html`
          <div class="flex shrink-0 items-center gap-3 border-b border-zinc-700/50 px-4 py-2">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              ${baseBranch && baseBranch !== branch ? html`
                <span class="text-xs font-mono text-zinc-500">${baseBranch}</span><span class="text-xs text-zinc-600">←</span>
              ` : nothing}
              <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                ${branchIcon("shrink-0 text-zinc-500", 12)}${branch}
              </span>
            </div>
          </div>
        ` : nothing}
        <div class="min-h-0 flex-1 overflow-y-auto" data-review-scroll>
          ${loading
            ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">Loading Reins diff…</div>`
            : data?.parseError
              ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Unable to parse patch: ${data.parseError}</div>`
              : changes.length > 0
                ? html`<div data-review-virtual-window style=${`position:relative;height:${virtualWindow.totalHeight}px`}>
                    ${repeat(
                      mountedItems,
                      (entry) => entry.id,
                      (entry) => {
                        const change = changeById.get(entry.id);
                        if (!change) return nothing;
                        return html`
                          <review-file-diff
                            style=${`position:absolute;top:${entry.top + entry.gapBefore}px;left:0;right:0`}
                            data-review-item-id=${change.id}
                            data-file-path=${change.path}
                            ?data-review-first=${change === changes[0]}
                            .change=${change}
                            .collapsed=${this.isItemCollapsed(change.id)}
                            .projectId=${this.store?.projectId ?? null}
                            .branch=${branch ?? null}
                            .reservedHeight=${Math.max(1, entry.height - entry.gapBefore)}
                            .contextState=${this._ensureContextState()}
                            .inlineReview=${this._inlineReview.file(change.id)}
                            .onToggleCollapse=${this._toggleFileCollapse}
                            .onHeightChange=${this._handleFileHeightChange}
                            .onCommentLayoutChange=${this._handleCommentLayoutChange}
                            .onContextExpansion=${this._expandFileContext}
                          ></review-file-diff>
                        `;
                      },
                    )}
                  </div>`
                : html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">No changes yet</div>`}
        </div>
        ${hasSavedComments ? html`
          <div class="pointer-events-none absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-[var(--layer-content)] flex max-w-[calc(100%-2rem)] flex-col items-end gap-2">
            ${this.reviewStore?.submissionError ? html`
              <span role="alert" class="rounded-md border border-red-900/70 bg-zinc-900/95 px-3 py-2 text-right text-xs text-red-400 shadow-lg">${this.reviewStore.submissionError}</span>
            ` : nothing}
            <button
              type="button"
              class="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-sky-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-black/30 hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
              aria-disabled=${String(!canSubmit)}
              ?disabled=${!canSubmit}
              @click=${() => { void this._submitReview(); }}
            >${conversationIcon("shrink-0", 15)}${this.reviewStore?.submitting ? "Submitting…" : "Submit review"}</button>
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-diff-panel": ReviewDiffPanel;
  }
}
