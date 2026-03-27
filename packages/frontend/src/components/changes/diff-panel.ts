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
import type { DiffFile } from "../../models/changes/types.js";
import type { DiffStore } from "../../models/stores/diff-store.js";
import type { FileTreeState } from "../../models/changes/file-tree-state.js";
import type { ExpandDetail } from "./diff-hunk.js";
import { fileCardId } from "../../models/changes/diff-utils.js";
import { ScrollSpy } from "../../models/changes/scroll-spy.js";
import "./diff-file-tree.js";
import "./diff-file-card.js";

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

  /** The file path currently topmost in the scroll viewport. */
  @state() private activeFile: string | null = null;

  /** Tracks which expand buttons are currently loading. */
  @state() private expandingHunks = new Set<string>();

  /** File path to scroll to once diff data loads. */
  private _pendingScrollTarget: string | null = null;

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
    if (this._pendingScrollTarget && this.store?.fullData) {
      const target = this._pendingScrollTarget;
      this._pendingScrollTarget = null;
      // Wait for Lit to render the new file cards, then scroll
      requestAnimationFrame(() => this.scrollToFile(target));
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
      this._pendingScrollTarget = null;
    } else {
      // Data not loaded yet — scroll once it arrives
      this._pendingScrollTarget = path;
    }
  }

  private handleFileSelect(e: Event) {
    if (!(e instanceof CustomEvent)) return;
    const path: string = e.detail;
    this.scrollToFile(path);
  }

  // ---- Child event handlers -------------------------------------------------

  private async _onExpandUp(e: Event) {
    if (!(e instanceof CustomEvent)) return;
    const { filePath, hunkIndex }: ExpandDetail = e.detail;
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
    if (!(e instanceof CustomEvent)) return;
    const { filePath, hunkIndex }: ExpandDetail = e.detail;
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
      if (el instanceof HTMLElement && el.dataset.hunkIndex === String(hunkIndex)) {
        return el;
      }
    }
    return null;
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
        .expandingHunks=${this.expandingHunks}
        .projectId=${this.store?.projectId ?? null}
        .branch=${this.store?.branch ?? this.store?.fileData.branch ?? null}
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
