import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  VirtualListController,
  type VirtualListObservation,
} from "../../controllers/virtual-list-controller.js";
import {
  ReviewCollapseState,
  reviewContentFingerprint,
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
import {
  estimateFileChangeHeight,
  fileChangeGap,
} from "../../models/changes/review-virtual-layout.js";
import {
  clientTelemetry,
  type ClientTelemetryOperation,
} from "../../models/client-telemetry.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";
import {
  activeFileChangeEvent,
  activeItemChangeEvent,
} from "../events.js";
import { branchIcon } from "../icons.js";
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

  @property({ type: Boolean }) visible = false;

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

  constructor() {
    super();
    this._virtualList.observe = (observation) => this._observeVirtualList(observation);
  }

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
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

    if (geometry) this._transitionHeights.set(id, geometry.height);
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
    this._navigationTelemetry = null;
    this._contextState = null;
    this._contextScopeKey = "";
    this._transitionHeights.clear();
  }

  private _reconcilePatchData() {
    const source = this.store?.patchData.data ?? null;
    if (!source) {
      if (this._parsedSource || this._parsedData) {
        this._resetParsedData();
        this._syncVirtualItems();
      }
      return;
    }
    if (source === this._parsedSource) return;

    this._parsedSource = source;
    this._parsedData = reconcileFileChanges(
      this._parsedData,
      parseFileChanges(source.patch, source.cacheKeyPrefix),
    );
    if (this._activeItemId && !this._parsedData.changes.some((change) => change.id === this._activeItemId)) {
      this._activeItemId = null;
    }
    this._ensureContextState();
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
    return `${scope?.projectId ?? "none"}:${scope?.branch ?? "none"}:${change.id}:${reviewContentFingerprint(change.contentKey)}`;
  }

  private _syncVirtualItems() {
    const scope = this._collapseScope();
    this._virtualList.setItems((this._parsedData?.changes ?? []).map((change, index) => {
      const collapsed = scope ? this._collapseState.isCollapsed(scope, change) : false;
      return {
        id: change.id,
        measurementKey: this._measurementKey(change),
        estimatedHeight: estimateFileChangeHeight(change, false, index),
        fixedHeight: this._transitionHeights.get(change.id)
          ?? (collapsed ? estimateFileChangeHeight(change, true, index) : undefined),
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

    const collapsedHeight = estimateFileChangeHeight(change, true, index);
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
    const changeById = new Map(changes.map((change, index) => [change.id, { change, index }]));

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
        <div class="min-h-0 flex-1 overflow-y-auto" data-review-scroll>
          ${loading
            ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">Loading Reins diff…</div>`
            : data?.parseError
              ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Unable to parse patch: ${data.parseError}</div>`
              : changes.length > 0
                ? html`<div data-review-virtual-window style=${`position:relative;height:${virtualWindow.totalHeight}px`}>
                    ${repeat(
                      virtualWindow.items,
                      (entry) => entry.id,
                      (entry) => {
                        const record = changeById.get(entry.id);
                        if (!record) return nothing;
                        const { change, index } = record;
                        return html`
                          <review-file-diff
                            style=${`position:absolute;top:${entry.top}px;left:0;right:0`}
                            data-review-item-id=${change.id}
                            data-file-path=${change.path}
                            ?data-review-first=${change === changes[0]}
                            .change=${change}
                            .collapsed=${this.isItemCollapsed(change.id)}
                            .projectId=${this.store?.projectId ?? null}
                            .branch=${branch ?? null}
                            .reservedHeight=${Math.max(1, entry.height - fileChangeGap(index))}
                            .contextState=${this._ensureContextState()}
                            .onToggleCollapse=${this._toggleFileCollapse}
                            .onHeightChange=${this._handleFileHeightChange}
                            .onContextExpansion=${this._expandFileContext}
                          ></review-file-diff>
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
