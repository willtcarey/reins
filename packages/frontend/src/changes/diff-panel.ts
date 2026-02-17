/**
 * Diff Panel
 *
 * Lit web component that displays a syntax-highlighted git diff.
 * The backend returns raw diff hunks; syntax highlighting is performed
 * client-side via Shiki in a web worker.
 * Markdown files can be toggled between raw diff and rendered preview.
 * Uses light DOM for Tailwind compatibility.
 *
 * Receives its data from a shared DiffStore instance.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import type { DiffFile, DiffHunk, DiffLine } from "./types.js";
import type { DiffStore } from "./diff-store.js";
import type { FileTreeState } from "./file-tree-state.js";
import { ScrollSpy } from "./scroll-spy.js";
import "./diff-file-tree.js";

// Configure marked for markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ---- Constants -------------------------------------------------------------

const EXPAND_STEP = 20;

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

/** Convert a file path to a valid HTML id for scroll targeting. */
function fileCardId(path: string): string {
  return "diff-" + path.replace(/[^a-zA-Z0-9_-]/g, "_");
}

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
      // Fetch if we're already visible when the store is set
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
    // Release the full diff data when leaving the view
    this.store?.clearFullDiff();
  }

  /** Re-fetch the full diff, clearing stale component-level state. */
  private _fetchFresh() {
    this.collapsedFiles = new Set();
    this.renderedFiles = new Set();
    this.markdownCache = new Map();
    this.markdownLoading = new Set();
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
      this.fetchMarkdown(p);
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

  private toggleFile(path: string) {
    const next = new Set(this.collapsedFiles);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.collapsedFiles = next;
  }

  private async toggleRendered(path: string) {
    const next = new Set(this.renderedFiles);
    if (next.has(path)) {
      next.delete(path);
      this.renderedFiles = next;
      return;
    }

    // Switch to rendered mode
    next.add(path);
    this.renderedFiles = next;

    // Fetch content if not cached
    if (!this.markdownCache.has(path)) {
      await this.fetchMarkdown(path);
    }
  }

  private async fetchMarkdown(path: string) {
    const projectId = this.store?.projectId;
    if (projectId == null) return;

    const loadingNext = new Set(this.markdownLoading);
    loadingNext.add(path);
    this.markdownLoading = loadingNext;

    try {
      const resp = await fetch(
        `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`
      );
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private renderLine(line: DiffLine) {
    let prefix = " ";
    let classes = "text-zinc-300";
    const lineNo = line.newLine ?? line.oldLine;

    switch (line.type) {
      case "add":
        prefix = "+";
        classes = "diff-add";
        break;
      case "remove":
        prefix = "-";
        classes = "diff-remove";
        break;
      case "context":
        prefix = " ";
        classes = "text-zinc-400";
        break;
    }

    // Always use unsafeHTML so the directive type is consistent across renders.
    // Switching between a plain text value and unsafeHTML in the same template
    // position causes Lit to retain the old text node alongside the directive's
    // nodes, resulting in duplicate lines.
    const content = unsafeHTML(line.html ?? this.escapeHtml(line.text));

    return html`<div class="${classes} px-2 leading-5 whitespace-pre font-mono"><span class="select-none text-zinc-600 mr-1 inline-block w-[3.5ch] text-right">${lineNo ?? ""}</span><span class="select-none text-zinc-600 mr-2">${prefix}</span>${content}</div>`;
  }

  private renderExpandButton(label: string, onClick: () => void) {
    return html`
      <button
        class="w-full py-1 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 cursor-pointer flex items-center justify-center gap-1 border-t border-zinc-700/50 transition-colors"
        @click=${onClick}
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
        ${label}
      </button>
    `;
  }

  private renderHunkSeparator(prevHunk: DiffHunk | null, nextHunk: DiffHunk) {
    if (!prevHunk) {
      // First hunk — check if there are hidden lines above
      const firstLine = nextHunk.lines[0];
      const startLine = firstLine?.newLine ?? firstLine?.oldLine ?? 1;
      if (startLine > 1) {
        return this.renderExpandButton(
          `Show more lines above`,
          () => this.store?.expandContext(EXPAND_STEP)
        );
      }
      return nothing;
    }

    // Calculate gap between hunks
    const prevLastLine = this.getHunkEndLine(prevHunk);
    const nextFirstLine = nextHunk.lines[0]?.newLine ?? nextHunk.lines[0]?.oldLine ?? 0;
    const gap = nextFirstLine - prevLastLine - 1;
    if (gap > 0) {
      return this.renderExpandButton(
        `Expand ${gap} hidden line${gap !== 1 ? "s" : ""}`,
        () => this.store?.expandContext(EXPAND_STEP)
      );
    }

    return nothing;
  }

  private getHunkEndLine(hunk: DiffHunk): number {
    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const line = hunk.lines[i];
      if (line.newLine != null) return line.newLine;
      if (line.oldLine != null) return line.oldLine;
    }
    return 0;
  }

  private renderMarkdownPreview(file: DiffFile) {
    const isLoading = this.markdownLoading.has(file.path);
    const rendered = this.markdownCache.get(file.path);

    // Only show spinner on initial load, not background refreshes
    if (isLoading && !rendered) {
      return html`
        <div class="p-4 text-zinc-500 text-sm flex items-center gap-2">
          <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Loading preview…
        </div>
      `;
    }

    if (rendered) {
      return html`
        <div class="p-5 prose prose-invert prose-sm max-w-none break-words leading-relaxed">
          ${unsafeHTML(rendered)}
        </div>
      `;
    }

    return html`
      <div class="p-4 text-zinc-500 text-sm">No content available</div>
    `;
  }

  private renderViewToggle(file: DiffFile) {
    if (!isMarkdown(file.path)) return nothing;

    const isRendered = this.renderedFiles.has(file.path);

    return html`
      <div class="flex items-center border-b border-zinc-700 bg-zinc-800/50" @click=${(e: Event) => e.stopPropagation()}>
        <button
          class="px-3 py-1.5 text-xs cursor-pointer transition-colors ${
            !isRendered
              ? "text-zinc-200 border-b-2 border-blue-400"
              : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent"
          }"
          @click=${() => { if (isRendered) this.toggleRendered(file.path); }}
        >
          <span class="flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
            </svg>
            Diff
          </span>
        </button>
        <button
          class="px-3 py-1.5 text-xs cursor-pointer transition-colors ${
            isRendered
              ? "text-zinc-200 border-b-2 border-blue-400"
              : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent"
          }"
          @click=${() => { if (!isRendered) this.toggleRendered(file.path); }}
        >
          <span class="flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            Preview
          </span>
        </button>
      </div>
    `;
  }

  private renderDiffContent(file: DiffFile) {
    return html`
      <div class="text-xs overflow-x-auto">
        <div class="min-w-full w-fit">
        ${file.hunks.map(
          (hunk, i) => html`
            ${this.renderHunkSeparator(i > 0 ? file.hunks[i - 1] : null, hunk)}
            <div class="bg-zinc-900/50 px-2 py-1 text-zinc-500 text-xs border-t border-zinc-700 font-mono">
              ${hunk.header}
            </div>
            ${hunk.lines.map((line) => this.renderLine(line))}
          `
        )}
        </div>
      </div>
    `;
  }

  private renderFile(file: DiffFile) {
    const collapsed = this.collapsedFiles.has(file.path);
    const isMd = isMarkdown(file.path);
    const isRendered = isMd && this.renderedFiles.has(file.path);

    return html`
      <div class="mb-3 border border-zinc-700 rounded-lg" id=${fileCardId(file.path)} data-file-path=${file.path}>
        <button
          class="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-750 text-sm cursor-pointer sticky top-0 z-10 rounded-t-lg border-b border-zinc-700"
          @click=${() => this.toggleFile(file.path)}
        >
          <span class="text-zinc-500 font-mono text-xs">${collapsed ? "▶" : "▼"}</span>
          <span class="font-mono text-zinc-200 flex-1 text-left truncate">${file.path}</span>
          ${isMd ? html`<span class="text-blue-400 text-xs font-mono px-1.5 py-0.5 bg-blue-400/10 rounded">MD</span>` : nothing}
          ${file.additions > 0 ? html`<span class="text-green-400 text-xs font-mono">+${file.additions}</span>` : nothing}
          ${file.removals > 0 ? html`<span class="text-red-400 text-xs font-mono">-${file.removals}</span>` : nothing}
        </button>
        ${!collapsed ? html`
          ${this.renderViewToggle(file)}
          ${isRendered
            ? this.renderMarkdownPreview(file)
            : this.renderDiffContent(file)
          }
        ` : nothing}
      </div>
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

    if (this.store.fullLoading && !this.store.fullData) {
      return html`
        <div class="flex items-center justify-center h-full text-zinc-500 text-sm gap-2">
          <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Loading diff…
        </div>
      `;
    }

    const fullData = this.store.fullData;
    const files = fullData?.files ?? [];
    const branch = fullData?.branch ?? this.store.fileData.branch;
    const baseBranch = fullData?.baseBranch ?? this.store.fileData.baseBranch;
    const { contextLines, defaultContext } = this.store;

    if (files.length === 0) {
      return html`
        <div class="flex items-center justify-center h-full text-zinc-500 text-sm">
          No changes yet
        </div>
      `;
    }

    return html`
      <div class="h-full flex flex-col">
        <!-- Header: branch info & context controls -->
        <div class="flex items-center gap-2 px-4 py-2 flex-wrap shrink-0 border-b border-zinc-700/50">
          ${branch ? html`
            <span class="inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
              <svg class="w-3 h-3 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
              </svg>
              ${branch}
            </span>
          ` : nothing}
          ${baseBranch && branch && baseBranch !== branch ? html`
            <span class="text-xs text-zinc-600">←</span>
            <span class="text-xs font-mono text-zinc-500">${baseBranch}</span>
          ` : nothing}
          <div class="flex-1"></div>
          <span class="text-xs text-zinc-500">Context: ${contextLines} lines</span>
          ${contextLines > defaultContext
            ? html`<button
                class="text-xs text-zinc-500 hover:text-zinc-300 underline cursor-pointer"
                @click=${() => this.store?.resetContext()}
              >Reset</button>`
            : nothing}
        </div>

        <!-- Two-column layout: diff list + file tree -->
        <div class="flex-1 flex min-h-0">
          <!-- Scrollable diff list -->
          <div class="flex-1 overflow-y-auto p-4" data-diff-scroll>
            ${files.map((file) => this.renderFile(file))}
          </div>

          <!-- File tree sidebar -->
          <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
            <diff-file-tree
              .store=${this.store}
              .treeState=${this.treeState}
              .activeFile=${this.activeFile}
              @file-select=${this.handleFileSelect}
            ></diff-file-tree>
          </div>
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
