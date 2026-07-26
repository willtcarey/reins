import { FileDiff, type ChangeTypes, type FileDiffOptions } from "@pierre/diffs";
import { LitElement, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  getPierreWorkerPool,
  PIERRE_SHIKI_THEME,
  subscribeToPierreDiffHighlightErrors,
} from "../../models/changes/pierre-worker-pool.js";
import { ScrollSpy } from "../../models/changes/scroll-spy.js";
import {
  parseVirtualizedReviewItems,
  type VirtualizedReviewItem,
  type VirtualizedReviewItemsResult,
} from "../../models/changes/virtualized-review-items.js";
import type { DiffPatchData, DiffStore } from "../../models/stores/diff-store.js";

const REINS_DIFF_OPTIONS: FileDiffOptions<undefined> = {
  theme: PIERRE_SHIKI_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  hunkSeparators: "line-info",
  disableFileHeader: true,
};

const STATUS_ICON_DETAILS: Record<ChangeTypes, {
  label: string;
  colorClass: string;
  glyph: ReturnType<typeof svg>;
}> = {
  change: {
    label: "Modified file",
    colorClass: "text-sky-400",
    glyph: svg`<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6"/>`,
  },
  new: {
    label: "Added file",
    colorClass: "text-green-500",
    glyph: svg`<path d="M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4"/>`,
  },
  deleted: {
    label: "Deleted file",
    colorClass: "text-red-400",
    glyph: svg`<path d="M4 8a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8"/>`,
  },
  "rename-pure": {
    label: "Renamed file",
    colorClass: "text-violet-400",
    glyph: svg`<path d="M8.5 4.7a.75.75 0 0 0-.05 1.06L10.5 8l-2.05 2.25a.75.75 0 0 0 1.11 1l2.5-2.75a.75.75 0 0 0 0-1l-2.5-2.75a.75.75 0 0 0-1.06-.05m-4 0a.75.75 0 0 0-.05 1.06L6.5 8 4.7 10a.75.75 0 0 0 1.11 1l2.25-2.5a.75.75 0 0 0 0-1l-2.5-2.75a.75.75 0 0 0-1.06-.05"/>`,
  },
  "rename-changed": {
    label: "Renamed file",
    colorClass: "text-violet-400",
    glyph: svg`<path d="M8.5 4.7a.75.75 0 0 0-.05 1.06L10.5 8l-2.05 2.25a.75.75 0 0 0 1.11 1l2.5-2.75a.75.75 0 0 0 0-1l-2.5-2.75a.75.75 0 0 0-1.06-.05m-4 0a.75.75 0 0 0-.05 1.06L6.5 8 4.7 10a.75.75 0 0 0 1.11 1l2.25-2.5a.75.75 0 0 0 0-1l-2.5-2.75a.75.75 0 0 0-1.06-.05"/>`,
  },
};

const STATUS_ICON_FRAME = svg`<path d="M1.79 4.3c.2-.88.48-1.39.8-1.71s.83-.61 1.71-.8C5.19 1.59 6.39 1.5 8 1.5s2.81.09 3.7.29c.88.19 1.39.48 1.71.8s.61.83.8 1.71c.2.89.29 2.09.29 3.7s-.09 2.81-.29 3.7c-.19.88-.48 1.39-.8 1.71s-.83.61-1.71.8c-.89.2-2.09.29-3.7.29s-2.81-.09-3.7-.29c-.88-.19-1.39-.48-1.71-.8s-.6-.83-.8-1.71C1.59 10.81 1.5 9.61 1.5 8s.09-2.81.29-3.7M8 0C1.41 0 0 1.41 0 8s1.41 8 8 8 8-1.41 8-8S14.59 0 8 0"/>`;

type PierreBackgroundSource = Pick<CSSStyleDeclaration, "backgroundColor" | "getPropertyValue">;
type PierreBackgroundTarget = Pick<CSSStyleDeclaration, "setProperty">;

export function applyPierreDiffBackground(source: PierreBackgroundSource, target: PierreBackgroundTarget): boolean {
  const background = source.getPropertyValue("--diffs-bg").trim() || source.backgroundColor.trim();
  if (!background || background === "transparent" || background === "rgba(0, 0, 0, 0)") return false;
  target.setProperty("--reins-diff-background", background);
  return true;
}

function renderStatusIcon(status: ChangeTypes) {
  const details = STATUS_ICON_DETAILS[status];
  return html`
    <svg
      class="h-3 w-3 shrink-0 ${details.colorClass}"
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label="${details.label}"
    >
      <title>${details.label}</title>
      ${STATUS_ICON_FRAME}${details.glyph}
    </svg>
  `;
}

@customElement("virtualized-diff-item")
export class VirtualizedDiffItem extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) item: VirtualizedReviewItem | null = null;
  @state() private highlightError: string | null = null;

  private _fileDiff: FileDiff | null = null;
  private _renderedItem: VirtualizedReviewItem | null = null;
  private _root: HTMLElement | null = null;
  private _backgroundSyncFrame: number | null = null;
  private _backgroundObserver: MutationObserver | null = null;
  private _unsubscribeHighlightErrors: (() => void) | null = null;

  override updated() {
    this._syncFileDiff();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyFileDiff();
  }

  public reportHighlightError(error: unknown) {
    this.highlightError = error instanceof Error ? error.message : String(error);
  }

  private _syncFileDiff() {
    const root = this.querySelector<HTMLElement>("[data-pierre-file-diff]");
    if (!root || !this.item) {
      this._destroyFileDiff();
      return;
    }
    if (this._fileDiff && this._root === root && this._renderedItem === this.item) return;

    this._destroyFileDiff();
    this.highlightError = null;
    this._unsubscribeHighlightErrors = subscribeToPierreDiffHighlightErrors(
      this.item.cacheKey,
      (error) => this.reportHighlightError(error),
    );
    this._fileDiff = new FileDiff(REINS_DIFF_OPTIONS, getPierreWorkerPool(), true);
    this._root = root;
    this._renderedItem = this.item;
    this._fileDiff.render({ fileDiff: this.item.fileDiff, fileContainer: root });
    this._scheduleBackgroundSync(root);
  }

  private _scheduleBackgroundSync(root: HTMLElement, attemptsRemaining = 30) {
    if (this._backgroundSyncFrame !== null) cancelAnimationFrame(this._backgroundSyncFrame);
    this._backgroundSyncFrame = requestAnimationFrame(() => {
      this._backgroundSyncFrame = null;
      if (this._root !== root) return;

      const shadowRoot = root.shadowRoot;
      const surface = shadowRoot?.querySelector<HTMLElement>("[data-diff]");
      if (!shadowRoot || !surface) {
        if (attemptsRemaining > 1) this._scheduleBackgroundSync(root, attemptsRemaining - 1);
        return;
      }

      applyPierreDiffBackground(getComputedStyle(surface), this.style);
      if (!this._backgroundObserver && typeof MutationObserver !== "undefined") {
        this._backgroundObserver = new MutationObserver(() => this._scheduleBackgroundSync(root));
        this._backgroundObserver.observe(shadowRoot, {
          attributes: true,
          attributeFilter: ["style"],
          childList: true,
          subtree: true,
        });
      }
    });
  }

  private _destroyFileDiff() {
    this._unsubscribeHighlightErrors?.();
    this._unsubscribeHighlightErrors = null;
    if (this._backgroundSyncFrame !== null) cancelAnimationFrame(this._backgroundSyncFrame);
    this._backgroundSyncFrame = null;
    this._backgroundObserver?.disconnect();
    this._backgroundObserver = null;
    this._fileDiff?.cleanUp();
    this._fileDiff = null;
    this._root = null;
    this._renderedItem = null;
  }

  override render() {
    const item = this.item;
    if (!item) return nothing;

    return html`
      <article class="border-b border-zinc-700/70 bg-zinc-950">
        <header class="reins-diff-header sticky top-0 z-10 flex min-w-0 items-center gap-2 px-3 py-2">
          ${renderStatusIcon(item.status)}
          ${item.oldPath && item.oldPath !== item.path
            ? html`
                <span class="reins-diff-path min-w-0 truncate font-mono text-xs text-zinc-500" title=${item.oldPath}>
                  <bdi>${item.oldPath}</bdi>
                </span>
                <span class="shrink-0 text-xs text-zinc-500" aria-hidden="true">→</span>
              `
            : nothing}
          <span class="reins-diff-path min-w-0 truncate font-mono text-xs text-zinc-200" title=${item.path}>
            <bdi>${item.path}</bdi>
          </span>
        </header>
        ${this.highlightError
          ? html`<div role="alert" class="border-b border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              <span class="font-semibold">Syntax highlighting failed:</span> ${this.highlightError}
            </div>`
          : nothing}
        <diffs-container data-pierre-file-diff></diffs-container>
      </article>
    `;
  }
}

interface VirtualizedDiffData extends VirtualizedReviewItemsResult {
  branch: string | null;
  baseBranch: string | null;
}

/**
 * Reins-owned renderer scaffold. It intentionally mounts every review item;
 * this is a functional boundary for a later top-level virtual list, not a
 * performance solution.
 */
@customElement("virtualized-diff-panel")
export class VirtualizedDiffPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: DiffStore | null = null;
  @property({ type: Boolean }) visible = false;
  private activeItemId: string | null = null;

  private _unsubscribe: (() => void) | null = null;
  private _pendingPath: string | null = null;
  private _pendingItemId: string | null = null;
  private _parsedSource: DiffPatchData | null = null;
  private _parsedData: VirtualizedDiffData | null = null;
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
    if (changed.has("store")) {
      this._subscribe();
      this._resetParsedData();
      if (this.visible) this._fetchFresh();
    }
    if (changed.has("visible") && this.visible) this._fetchFresh();
  }

  override updated() {
    this._scrollSpy.update(this);
    const data = this._getParsedData();
    if (!this.activeItemId && data?.items[0]) this.reportActiveItem(data.items[0].id);
    this._syncPendingScroll();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._scrollSpy.destroy();
    this.store?.clearPatchDiff();
  }

  public itemIdForPath(path: string): string | null {
    return this._getParsedData()?.pathToItemId.get(path) ?? null;
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
    if (id === this.activeItemId) return;
    const item = this._getParsedData()?.items.find((candidate) => candidate.id === id);
    if (!item) return;

    this.activeItemId = id;
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
      this.requestUpdate();
    });
  }

  private _fetchFresh() {
    void this.store?.fetchPatchDiff();
  }

  private _resetParsedData() {
    this._parsedSource = null;
    this._parsedData = null;
    this.activeItemId = null;
  }

  private _getParsedData(): VirtualizedDiffData | null {
    const source = this.store?.patchData.data ?? null;
    if (!source) {
      this._resetParsedData();
      return null;
    }
    if (source === this._parsedSource) return this._parsedData;

    this._parsedSource = source;
    this.activeItemId = null;
    this._parsedData = {
      ...parseVirtualizedReviewItems(source.patch, source.cacheKeyPrefix, source.version),
      branch: source.branch,
      baseBranch: source.baseBranch,
    };
    return this._parsedData;
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
    const data = this._getParsedData();
    const items = data?.items ?? [];

    return html`
      <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-700/50 px-4 py-2">
          <span class="rounded border border-purple-500/25 bg-purple-500/15 px-2 py-1 text-xs font-semibold text-purple-300">Reins diff scaffold</span>
          <span class="text-[10px] text-zinc-500">non-virtual; not a performance solution</span>
          ${data?.baseBranch && data.branch && data.baseBranch !== data.branch
            ? html`<span class="font-mono text-xs text-zinc-500">${data.baseBranch} ← ${data.branch}</span>`
            : data?.branch ? html`<span class="font-mono text-xs text-zinc-400">${data.branch}</span>` : nothing}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto" data-review-scroll>
          ${loading
            ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">Loading Reins diff…</div>`
            : data?.parseError
              ? html`<div class="flex h-full items-center justify-center p-4 text-sm text-red-400">Unable to parse patch: ${data.parseError}</div>`
              : items.length > 0
                ? items.map((item) => html`
                    <virtualized-diff-item
                      data-review-item-id=${item.id}
                      data-file-path=${item.path}
                      .item=${item}
                    ></virtualized-diff-item>
                  `)
                : html`<div class="flex h-full items-center justify-center p-4 text-sm text-zinc-500">No changes yet</div>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "virtualized-diff-item": VirtualizedDiffItem;
    "virtualized-diff-panel": VirtualizedDiffPanel;
  }
}
