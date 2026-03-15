/**
 * Diff Panel
 *
 * Lit web component that displays a syntax-highlighted git diff.
 * This is a thin layout shell that delegates per-file rendering to
 * `<diff-file-card>`, hunk expansion to `<diff-hunk>`, and markdown
 * preview to `<diff-markdown-preview>`.
 *
 * Receives its data from a shared DiffStore instance.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { marked } from "marked";
import type { DiffFile } from "./types.js";
import type { DiffStore } from "../stores/diff-store.js";
import type { FileTreeState } from "./file-tree-state.js";
import type { ExpandDetail } from "./diff-hunk.js";
import { fileCardId } from "./diff-utils.js";
import { ScrollSpy } from "./scroll-spy.js";
import "./diff-file-tree.js";
import "./diff-file-card.js";

// Configure marked for markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ---- Component --------------------------------------------------------------

@customElement("diff-panel")
export class DiffPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Shared diff data store. */
  @property({ attribute: false })
  store: DiffStore | null = null;

  /** Shared file tree UI state. */
  @property({ attribute: false })
  treeState: FileTreeState | null = null;

  /** Whether this panel is currently visible (set by the parent). */
  @property({ type: Boolean })
  visible = false;

  @state() private collapsedFiles = new Set<string>();

  /** Tracks which markdown files are in "rendered" mode vs "raw" (diff) mode */
  @state() private renderedFiles = new Set<string>();
  /** Cache of fetched markdown content: path → rendered HTML */
  @state() private markdownCache = new Map<string, string>();
  /** Tracks which files are currently being fetched */
  @state() private markdownLoading = new Set<string>();

  /** The file path currently topmost in the scroll viewport. */
  @state() private activeFile: string | null = null;

  /** Tracks which expand buttons are currently loading. */
  @state() private expandingHunks = new Set<string>();

  private _unsubscribe: (() => void) | null = null;

  private scrollSpy = new ScrollSpy({
    containerSelector: "[data-diff-scroll]",
    itemSelector: "[data-file-path]",
    dataAttribute: "filePath",
    onActiveChange: (path) => { this.activeFile = path; },
  });

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._subscribe();
      if (this.visible) this._fetchFresh();
    }
    if (changed.has("visible")) {
      if (this.visible) {
        this._fetchFresh();
      }
    }
  }

  override updated() {
    this.scrollSpy.update(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this.scrollSpy.destroy();
    this.store?.clearFullDiff();
  }

  /** Re-fetch the full diff, clearing stale component-level state. */
  private _fetchFresh() {
    this.collapsedFiles = new Set();
    this.renderedFiles = new Set();
    this.markdownCache = new Map();
    this.markdownLoading = new Set();
    this.expandingHunks = new Set();
    this.store?.fetchFullDiff();
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.store) {
      this._unsubscribe = this.store.subscribe(() => {
        this._onStoreUpdate();
        this.requestUpdate();
      });
    }
  }

  /** Called when the store notifies us of new data. */
  private _onStoreUpdate() {
    if (!this.store) return;

    const files = this.store.fullData?.files ?? [];

    // Clean up markdown cache for files no longer in the diff
    const cacheNext = new Map(this.markdownCache);
    let cacheChanged = false;
    for (const key of cacheNext.keys()) {
      if (!files.some((f) => f.path === key)) {
        cacheNext.delete(key);
        cacheChanged = true;
      }
    }
    if (cacheChanged) this.markdownCache = cacheNext;

    // Re-fetch markdown for files currently in rendered mode
    const activePaths = [...this.renderedFiles].filter((p) =>
      files.some((f) => f.path === p)
    );
    for (const p of activePaths) {
      this._fetchMarkdown(p);
    }
  }

  // ---- File navigation --------------------------------------------------------

  /**
   * Scroll to a file's diff card by path.
   * Can be called externally (e.g. from app-shell) or internally via tree click.
   */
  public scrollToFile(path: string) {
    const card = this.querySelector(`#${CSS.escape(fileCardId(path))}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  private handleFileSelect(e: Event) {
    const path = (e as CustomEvent<string>).detail;
    this.scrollToFile(path);
  }

  // ---- Child event handlers -------------------------------------------------

  private _onToggleCollapse(e: Event) {
    const path = (e as CustomEvent<string>).detail;
    const next = new Set(this.collapsedFiles);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.collapsedFiles = next;
  }

  private async _onToggleRendered(e: Event) {
    const path = (e as CustomEvent<string>).detail;
    const next = new Set(this.renderedFiles);
    if (next.has(path)) {
      next.delete(path);
      this.renderedFiles = next;
      return;
    }

    next.add(path);
    this.renderedFiles = next;

    if (!this.markdownCache.has(path)) {
      await this._fetchMarkdown(path);
    }
  }

  private async _onExpandUp(e: Event) {
    const { filePath, hunkIndex } = (e as CustomEvent<ExpandDetail>).detail;
    const key = `${filePath}:${hunkIndex}:up`;
    if (this.expandingHunks.has(key)) return;

    const container = this._scrollContainer;
    const scrollBefore = container?.scrollTop ?? 0;

    const hunkEl = this._findHunkElement(filePath, hunkIndex);
    const rectBefore = hunkEl?.getBoundingClientRect();
    const containerRect = container?.getBoundingClientRect();

    this.expandingHunks = new Set(this.expandingHunks).add(key);
    const linesInserted = await this.store?.expandHunk(filePath, hunkIndex, "up") ?? 0;
    const next = new Set(this.expandingHunks);
    next.delete(key);
    this.expandingHunks = next;

    if (linesInserted > 0 && container && rectBefore && containerRect) {
      await this.updateComplete;
      const hunkElAfter = this._findHunkElement(filePath, hunkIndex);
      const rectAfter = hunkElAfter?.getBoundingClientRect();
      if (rectAfter) {
        const shift = rectAfter.top - rectBefore.top;
        container.scrollTop = scrollBefore + shift;
      }
    }
  }

  private async _onExpandDown(e: Event) {
    const { filePath, hunkIndex } = (e as CustomEvent<ExpandDetail>).detail;
    const key = `${filePath}:${hunkIndex}:down`;
    if (this.expandingHunks.has(key)) return;
    this.expandingHunks = new Set(this.expandingHunks).add(key);
    await this.store?.expandHunk(filePath, hunkIndex, "down");
    const next = new Set(this.expandingHunks);
    next.delete(key);
    this.expandingHunks = next;
  }

  // ---- Helpers --------------------------------------------------------------

  private get _scrollContainer(): HTMLElement | null {
    return this.querySelector("[data-diff-scroll]");
  }

  private _findHunkElement(filePath: string, hunkIndex: number): HTMLElement | null {
    const fileCard = this.querySelector(`#${CSS.escape(fileCardId(filePath))}`);
    if (!fileCard) return null;
    const hunkEls = fileCard.querySelectorAll("[data-hunk-index]");
    for (const el of hunkEls) {
      if ((el as HTMLElement).dataset.hunkIndex === String(hunkIndex)) {
        return el as HTMLElement;
      }
    }
    return null;
  }

  private _fileUrl(path: string): string | null {
    const projectId = this.store?.projectId;
    if (projectId == null) return null;
    const branch = this.store?.branch ?? this.store?.fileData.branch;
    let url = `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`;
    if (branch) url += `&ref=${encodeURIComponent(branch)}`;
    return url;
  }

  /** Bound file URL builder passed to child cards. */
  private _fileUrlFn = (path: string) => this._fileUrl(path);

  private async _fetchMarkdown(path: string) {
    const url = this._fileUrl(path);
    if (!url) return;

    const loadingNext = new Set(this.markdownLoading);
    loadingNext.add(path);
    this.markdownLoading = loadingNext;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        const cacheNext = new Map(this.markdownCache);
        cacheNext.set(path, `<p class="text-red-400">Failed to load file (HTTP ${resp.status})</p>`);
        this.markdownCache = cacheNext;
        return;
      }
      const raw = await resp.text();
      const rendered = marked.parse(raw) as string;
      const cacheNext = new Map(this.markdownCache);
      cacheNext.set(path, rendered);
      this.markdownCache = cacheNext;
    } catch (err: any) {
      const cacheNext = new Map(this.markdownCache);
      cacheNext.set(path, `<p class="text-red-400">Error: ${err.message}</p>`);
      this.markdownCache = cacheNext;
    } finally {
      const loadingNext = new Set(this.markdownLoading);
      loadingNext.delete(path);
      this.markdownLoading = loadingNext;
    }
  }

  // ---- Render helpers -------------------------------------------------------

  private renderSpinner() {
    return html`<svg class="w-3 h-3 animate-spin inline-block" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>`;
  }

  private renderBaseSyncStatus() {
    if (!this.store) return nothing;
    const { spread, syncAction } = this.store;
    if (!spread || spread.behindBase === 0) return nothing;

    return html`
      <span class="text-xs text-yellow-400">(${spread.behindBase} ahead)</span>
      <button
        class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        ?disabled=${syncAction !== "idle"}
        @click=${() => this.store?.rebase()}
      >
        ${syncAction === "rebasing" ? this.renderSpinner() : nothing}
        Rebase
      </button>
    `;
  }

  private renderBranchSyncStatus() {
    if (!this.store) return nothing;
    const { spread, syncAction, syncResult } = this.store;
    if (!spread) return nothing;

    const { aheadBase, aheadRemote, behindRemote } = spread;
    const neverPushed = aheadRemote === null && aheadBase > 0;
    const hasUnpushed = aheadRemote != null && aheadRemote > 0;

    return html`
      ${aheadBase > 0 ? html`
        <span class="text-xs text-zinc-400">${aheadBase} ahead</span>
      ` : nothing}
      ${hasUnpushed ? html`
        <span class="text-xs text-blue-400">${aheadRemote} unpushed</span>
      ` : nothing}
      ${hasUnpushed || neverPushed ? html`
        <button
          class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          ?disabled=${syncAction !== "idle"}
          @click=${() => this.store?.push()}
        >
          ${syncAction === "pushing" ? this.renderSpinner() : nothing}
          Push
        </button>
      ` : nothing}
      ${behindRemote != null && behindRemote > 0 ? html`
        <span class="text-xs text-orange-400">${behindRemote} behind origin</span>
      ` : nothing}
      ${syncResult && "error" in syncResult ? html`
        <span class="text-xs text-red-400">${syncResult.error}</span>
      ` : nothing}
      ${syncResult && "ok" in syncResult ? html`
        <span class="text-xs text-green-400">✓</span>
      ` : nothing}
    `;
  }

  private renderFile(file: DiffFile) {
    return html`
      <diff-file-card
        .file=${file}
        .store=${this.store}
        ?collapsed=${this.collapsedFiles.has(file.path)}
        ?rendered=${this.renderedFiles.has(file.path)}
        ?markdown-loading=${this.markdownLoading.has(file.path)}
        .markdownContent=${this.markdownCache.get(file.path) ?? null}
        .expandingHunks=${this.expandingHunks}
        .fileUrl=${this._fileUrlFn}
      ></diff-file-card>
    `;
  }

  override render() {
    if (!this.store) return nothing;

    const { error } = this.store;

    if (error) {
      return html`
        <div class="flex items-center justify-center h-full text-red-400 text-sm p-4">
          Error: ${error}
        </div>
      `;
    }

    const isInitialLoading = this.store.fullLoading && !this.store.fullData;
    const fullData = this.store.fullData;
    const files = fullData?.files ?? [];
    const branch = fullData?.branch ?? this.store.fileData.branch;
    const baseBranch = fullData?.baseBranch ?? this.store.fileData.baseBranch;

    return html`
      <div class="h-full flex min-h-0">
        <!-- Main content column -->
        <div class="flex-1 flex flex-col min-h-0 min-w-0">
          ${branch ? html`
            <!-- Header: branch info, sync status & context controls -->
            <div class="flex items-center gap-2 px-4 py-2 flex-wrap shrink-0 border-b border-zinc-700/50">
              ${baseBranch && baseBranch !== branch ? html`
                <span class="text-xs font-mono text-zinc-500">${baseBranch}</span>
                ${this.renderBaseSyncStatus()}
                <span class="text-xs text-zinc-600">←</span>
              ` : nothing}
              <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     class="shrink-0 text-zinc-500">
                  <line x1="6" y1="3" x2="6" y2="15"></line>
                  <circle cx="18" cy="6" r="3"></circle>
                  <circle cx="6" cy="18" r="3"></circle>
                  <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
                ${branch}
              </span>
              ${this.renderBranchSyncStatus()}
            </div>
          ` : nothing}

          <!-- Scrollable diff list -->
          <div class="flex-1 overflow-y-auto" data-diff-scroll
            @toggle-collapse=${this._onToggleCollapse}
            @toggle-rendered=${this._onToggleRendered}
            @expand-up=${this._onExpandUp}
            @expand-down=${this._onExpandDown}
          >
            ${isInitialLoading ? html`
              <div class="flex items-center justify-center h-full text-zinc-500 text-sm gap-2 p-4">
                <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                Loading diff…
              </div>
            ` : files.length > 0
              ? files.map((file) => this.renderFile(file))
              : html`<div class="flex items-center justify-center h-full text-zinc-500 text-sm p-4">No changes yet</div>`
            }
          </div>
        </div>

        <!-- File tree sidebar — always full height -->
        <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
          <diff-file-tree
            .store=${this.store}
            .treeState=${this.treeState}
            .activeFile=${this.activeFile}
            @file-select=${this.handleFileSelect}
          ></diff-file-tree>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-panel": DiffPanel;
  }
}
