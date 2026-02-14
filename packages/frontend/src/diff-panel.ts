/**
 * Diff Panel
 *
 * Lit web component that fetches and displays a syntax-highlighted git diff
 * from the backend. The backend returns pre-parsed, pre-highlighted HTML.
 * Markdown files can be toggled between raw diff and rendered preview.
 * Uses light DOM for Tailwind compatibility.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";

// Configure marked for markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ---- Types (mirrors backend response) -------------------------------------

interface DiffLine {
  type: "context" | "add" | "remove";
  html: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  additions: number;
  removals: number;
  hunks: DiffHunk[];
}

// ---- Constants -------------------------------------------------------------

const DEFAULT_CONTEXT = 3;
const EXPAND_STEP = 20;

function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

// ---- Component --------------------------------------------------------------

@customElement("diff-panel")
export class DiffPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Current project ID from the URL route. Null = no project selected. */
  @property({ type: Number })
  activeProjectId: number | null = null;

  @state() private files: DiffFile[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private collapsedFiles = new Set<string>();
  @state() private contextLines = DEFAULT_CONTEXT;

  /** Tracks which markdown files are in "rendered" mode vs "raw" (diff) mode */
  @state() private renderedFiles = new Set<string>();
  /** Cache of fetched markdown content: path → rendered HTML */
  @state() private markdownCache = new Map<string, string>();
  /** Tracks which files are currently being fetched */
  @state() private markdownLoading = new Set<string>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 5000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refresh() {
    if (this.activeProjectId == null) {
      this.files = [];
      this.error = null;
      return;
    }
    try {
      const resp = await fetch(`/api/projects/${this.activeProjectId}/diff?context=${this.contextLines}`);
      if (!resp.ok) {
        this.error = `HTTP ${resp.status}`;
        return;
      }
      const data = await resp.json();
      this.files = data.files ?? [];
      this.error = null;

      // Re-fetch markdown for files currently in rendered mode
      // so the preview stays up to date without flicker
      const activePaths = [...this.renderedFiles].filter((p) =>
        this.files.some((f) => f.path === p)
      );
      // Clear cache entries for files no longer in the diff
      const cacheNext = new Map(this.markdownCache);
      for (const key of cacheNext.keys()) {
        if (!this.files.some((f) => f.path === key)) cacheNext.delete(key);
      }
      this.markdownCache = cacheNext;

      // Silently refresh active rendered files in the background
      for (const p of activePaths) {
        this.fetchMarkdown(p);
      }
    } catch (err: any) {
      this.error = err.message ?? "Failed to fetch diff";
    }
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
    if (this.activeProjectId == null) return;

    const loadingNext = new Set(this.markdownLoading);
    loadingNext.add(path);
    this.markdownLoading = loadingNext;

    try {
      const resp = await fetch(
        `/api/projects/${this.activeProjectId}/file?path=${encodeURIComponent(path)}`
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

  private async expandContext() {
    this.contextLines += EXPAND_STEP;
    await this.refresh();
  }

  private async resetContext() {
    this.contextLines = DEFAULT_CONTEXT;
    await this.refresh();
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

    return html`<div class="${classes} px-2 leading-5 whitespace-pre font-mono"><span class="select-none text-zinc-600 mr-1 inline-block w-[3.5ch] text-right">${lineNo ?? ""}</span><span class="select-none text-zinc-600 mr-2">${prefix}</span>${unsafeHTML(line.html)}</div>`;
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
          () => this.expandContext()
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
        () => this.expandContext()
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
      <div class="mb-3 border border-zinc-700 rounded-lg">
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
    if (this.error) {
      return html`
        <div class="flex items-center justify-center h-full text-red-400 text-sm p-4">
          Error: ${this.error}
        </div>
      `;
    }

    if (this.files.length === 0) {
      return html`
        <div class="flex items-center justify-center h-full text-zinc-500 text-sm">
          No changes yet
        </div>
      `;
    }

    return html`
      <div class="h-full overflow-y-auto p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-xs text-zinc-500">Context: ${this.contextLines} lines</span>
          ${this.contextLines > DEFAULT_CONTEXT
            ? html`<button
                class="text-xs text-zinc-500 hover:text-zinc-300 underline cursor-pointer"
                @click=${() => this.resetContext()}
              >Reset</button>`
            : nothing}
        </div>
        ${this.files.map((file) => this.renderFile(file))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-panel": DiffPanel;
  }
}
