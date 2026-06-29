import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { DiffStore } from "../../models/stores/diff-store.js";
import type { FileTreeState } from "../../models/changes/file-tree-state.js";
import type { VirtualDiffItem, VirtualDiffRow } from "../../models/changes/virtual-diff.js";
import { buildVirtualDiffRows } from "../../models/changes/virtual-diff.js";
import { fileCardId } from "../../models/changes/diff-utils.js";
import { ScrollSpy } from "../../models/changes/scroll-spy.js";
import "./diff-file-tree.js";

@customElement("virtual-diff-panel")
export class VirtualDiffPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: DiffStore | null = null;
  @property({ attribute: false }) treeState: FileTreeState | null = null;
  @property({ type: Boolean }) visible = false;

  @state() private activeFile: string | null = null;

  private _pendingScrollTarget: string | null = null;
  private _unsubscribe: (() => void) | null = null;

  private scrollSpy = new ScrollSpy({
    containerSelector: "[data-virtual-diff-scroll]",
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
    if (changed.has("visible") && this.visible) {
      this._fetchFresh();
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
    this.store?.clearVirtualDiff();
  }

  public scrollToFile(path: string) {
    const card = this.querySelector(`#${CSS.escape(fileCardId(path))}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      this._pendingScrollTarget = null;
    } else {
      this._pendingScrollTarget = path;
    }
  }

  private _fetchFresh() {
    this.store?.fetchVirtualDiff();
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

  private _onStoreUpdate() {
    if (this.visible && this.store?.projectId != null && !this.store.virtualData && !this.store.virtualLoading && !this.store.virtualError) {
      void this.store.fetchVirtualDiff();
    }

    if (this._pendingScrollTarget && this.store?.virtualData) {
      const target = this._pendingScrollTarget;
      this._pendingScrollTarget = null;
      requestAnimationFrame(() => this.scrollToFile(target));
    }
  }

  private handleFileSelect(e: Event) {
    if (!(e instanceof CustomEvent)) return;
    this.scrollToFile(e.detail);
  }

  private lineNumberGutterCh(items: VirtualDiffItem[]): number {
    const maxLine = items.reduce((max, item) => {
      const rows = buildVirtualDiffRows(item.fileDiff);
      return rows.reduce((rowMax, row) => Math.max(rowMax, row.oldLine ?? 0, row.newLine ?? 0), max);
    }, 0);
    return Math.max(2, String(maxLine).length + 1);
  }

  private renderRow(row: VirtualDiffRow) {
    const oldLine = row.oldLine == null ? "" : String(row.oldLine);
    const newLine = row.newLine == null ? "" : String(row.newLine);
    const lineClass = row.type === "addition"
      ? "bg-emerald-950/35 text-emerald-100"
      : row.type === "deletion"
        ? "bg-red-950/35 text-red-100"
        : row.type === "hunk"
          ? "bg-blue-950/40 text-blue-300"
          : row.type === "collapsed"
            ? "bg-zinc-800/70 text-zinc-500 italic"
            : "text-zinc-300";
    const marker = row.type === "addition" ? "+" : row.type === "deletion" ? "-" : row.type === "hunk" ? "@" : " ";

    return html`
      <div
        class="grid text-xs font-mono leading-5 ${lineClass}"
        style="grid-template-columns: var(--virtual-diff-gutter) var(--virtual-diff-gutter) 1.25rem minmax(0, 1fr)"
      >
        <div class="pr-1 text-right select-none text-zinc-500 border-r border-zinc-800/80">${oldLine}</div>
        <div class="pr-1 text-right select-none text-zinc-500 border-r border-zinc-800/80">${newLine}</div>
        <div class="px-1 text-center select-none">${marker}</div>
        <pre class="m-0 px-2 whitespace-pre-wrap break-words">${row.text}</pre>
      </div>
    `;
  }

  private renderFile(item: VirtualDiffItem) {
    const rows = buildVirtualDiffRows(item.fileDiff);
    const additions = item.fileDiff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0);
    const deletions = item.fileDiff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0);

    return html`
      <section
        id=${fileCardId(item.path)}
        data-file-path=${item.path}
        class="m-3 rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden"
      >
        <header class="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
          <span class="font-mono text-sm text-zinc-200 truncate">${item.path}</span>
          ${item.fileDiff.prevName && item.fileDiff.prevName !== item.path ? html`
            <span class="text-xs text-zinc-500 truncate">from ${item.fileDiff.prevName}</span>
          ` : nothing}
          <span class="ml-auto text-xs text-emerald-400">+${additions}</span>
          <span class="text-xs text-red-400">−${deletions}</span>
        </header>
        ${rows.length > 0
          ? rows.map((row) => this.renderRow(row))
          : html`<div class="px-3 py-4 text-sm text-zinc-500">No textual hunks in this file.</div>`}
      </section>
    `;
  }

  override render() {
    if (!this.store) return nothing;

    const error = this.store.virtualError;
    if (error) {
      return html`
        <div class="flex items-center justify-center h-full text-red-400 text-sm p-4">
          Error: ${error}
        </div>
      `;
    }

    const isInitialLoading = this.store.virtualLoading && !this.store.virtualData;
    const data = this.store.virtualData;
    const items = data?.items ?? [];
    const gutterCh = this.lineNumberGutterCh(items);
    const branch = data?.branch ?? this.store.fileData.branch;
    const baseBranch = data?.baseBranch ?? this.store.fileData.baseBranch;

    return html`
      <div class="h-full flex min-h-0">
        <div class="flex-1 flex flex-col min-h-0 min-w-0">
          <div class="flex items-center gap-2 px-4 py-2 flex-wrap shrink-0 border-b border-zinc-700/50">
            <span class="text-xs font-semibold rounded bg-purple-500/15 text-purple-300 border border-purple-500/25 px-2 py-1">
              Virtual diff prototype
            </span>
            ${baseBranch && branch && baseBranch !== branch ? html`
              <span class="text-xs font-mono text-zinc-500">${baseBranch}</span>
              <span class="text-xs text-zinc-600">←</span>
            ` : nothing}
            ${branch ? html`
              <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                ${branch}
              </span>
            ` : nothing}
          </div>

          <div
            class="flex-1 overflow-y-auto"
            data-virtual-diff-scroll
            style=${`--virtual-diff-gutter: ${gutterCh}ch`}
          >
            ${isInitialLoading ? html`
              <div class="flex items-center justify-center h-full text-zinc-500 text-sm gap-2 p-4">
                <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                Loading virtual diff…
              </div>
            ` : items.length > 0
              ? items.map((item) => this.renderFile(item))
              : html`<div class="flex items-center justify-center h-full text-zinc-500 text-sm p-4">No changes yet</div>`
            }
          </div>
        </div>

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
    "virtual-diff-panel": VirtualDiffPanel;
  }
}
