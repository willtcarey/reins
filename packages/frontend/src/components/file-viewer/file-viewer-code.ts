/**
 * Code Viewer — syntax-highlighted, read-only code with line numbers.
 *
 * Renders text content with Shiki syntax highlighting via the shared
 * highlight worker. Handles large file truncation and per-file-type
 * line wrapping.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { shouldWrapLines } from "../../models/changes/diff-utils.js";
import { LazyHighlightController } from "../../controllers/lazy-highlight-controller.js";

/** Max lines to render before truncating. */
const MAX_RENDER_LINES = 5000;

/** Max file size (in characters) before we skip highlighting. */
const LARGE_FILE_THRESHOLD = 200_000;

@customElement("file-viewer-code")
export class FileViewerCode extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Raw text content to render. */
  @property({ attribute: false }) content: string | null = null;

  /** File path — used for syntax detection and line wrapping. */
  @property() path = "";

  /** Optional 1-based line range to highlight (inclusive). */
  @property({ attribute: false }) highlightRange: { startLine: number; endLine: number } | null = null;

  /** Whether we need to scroll to the highlight range after next render. */
  private _pendingScrollToHighlight = false;

  /** Line number where a gutter drag started, or null if not dragging. */
  private _gutterDragAnchor: number | null = null;

  /** Whether the current highlight was set by gutter interaction (skip scroll). */
  private _highlightFromGutter = false;

  private _highlight = new LazyHighlightController(this, () => {
    if (!this.content || !this.path) return null;
    // Skip highlighting for very large files
    if (this.content.length > LARGE_FILE_THRESHOLD) return null;
    const lines = this.content.split("\n");
    return {
      path: this.path,
      hunk: {
        header: "",
        lines: lines.map((text, i) => ({
          type: "context" as const,
          text,
          newLine: i + 1,
        })),
      },
    };
  });

  override connectedCallback() {
    super.connectedCallback();
    this._highlight.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._highlight.disconnect();
    // Clean up any in-progress gutter drag
    document.removeEventListener("mousemove", this._onGutterMouseMove);
    document.removeEventListener("mouseup", this._onGutterMouseUp);
    this._gutterDragAnchor = null;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("content") || changed.has("path")) {
      this._highlight.update();
    }
    if (changed.has("highlightRange") || changed.has("content")) {
      if (this.highlightRange && this.content && !this._highlightFromGutter) {
        this._pendingScrollToHighlight = true;
      }
      this._highlightFromGutter = false;
    }
  }

  override updated() {
    if (this._pendingScrollToHighlight) {
      this._pendingScrollToHighlight = false;
      this._scrollToHighlightRange();
    }
  }

  /**
   * Scroll the first highlighted line into view.
   * The scrollable container is the nearest ancestor with overflow-auto.
   */
  private _scrollToHighlightRange() {
    if (!this.highlightRange) return;
    const lineEl = this.querySelector(`[data-line="${this.highlightRange.startLine}"]`);
    if (!lineEl) return;
    // Find the scrollable container (the element with class overflow-auto, which is this element itself
    // or its parent depending on layout). scrollIntoView with nearest block avoids jarring jumps.
    requestAnimationFrame(() => {
      lineEl.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }

  /** Clear highlight when clicking outside the highlighted range (but not on gutter). */
  private _onLineClick = (e: MouseEvent) => {
    // Ignore clicks on the gutter — those are handled by the drag system
    if ((e.target as HTMLElement).closest?.("[data-gutter]")) return;
    if (!this.highlightRange) return;
    const lineEl = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
    if (!lineEl) return;
    const lineNo = parseInt(lineEl.dataset.line!, 10);
    if (lineNo >= this.highlightRange.startLine && lineNo <= this.highlightRange.endLine) return;
    this.highlightRange = null;
  };

  // ---- Gutter drag-to-highlight --------------------------------------------

  /** Start a gutter drag on mousedown. */
  private _onGutterMouseDown = (e: MouseEvent) => {
    const gutterEl = (e.target as HTMLElement).closest<HTMLElement>("[data-gutter]");
    if (!gutterEl) return;
    e.preventDefault(); // prevent text selection during drag
    const lineNo = parseInt(gutterEl.dataset.gutter!, 10);
    this._gutterDragAnchor = lineNo;
    this._highlightFromGutter = true;
    this.highlightRange = { startLine: lineNo, endLine: lineNo };
    document.addEventListener("mousemove", this._onGutterMouseMove);
    document.addEventListener("mouseup", this._onGutterMouseUp);
  };

  /** Extend the range as the mouse moves during a gutter drag. */
  private _onGutterMouseMove = (e: MouseEvent) => {
    if (this._gutterDragAnchor == null) return;
    const lineNo = this._lineFromPoint(e.clientX, e.clientY);
    if (lineNo == null) return;
    const anchor = this._gutterDragAnchor;
    this._highlightFromGutter = true;
    this.highlightRange = {
      startLine: Math.min(anchor, lineNo),
      endLine: Math.max(anchor, lineNo),
    };
  };

  /** Finalize the range on mouseup. */
  private _onGutterMouseUp = () => {
    this._gutterDragAnchor = null;
    document.removeEventListener("mousemove", this._onGutterMouseMove);
    document.removeEventListener("mouseup", this._onGutterMouseUp);
  };

  /** Resolve a screen point to a 1-based line number using the data-line divs. */
  private _lineFromPoint(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const lineEl = (el as HTMLElement).closest<HTMLElement>("[data-line]");
    if (!lineEl) return null;
    return parseInt(lineEl.dataset.line!, 10);
  }

  /** Clear highlight cache. Call when the viewer is hidden/reused. */
  resetHighlight() {
    // Trigger re-evaluation on next update by clearing the lazy controller's cache
    this._highlight.update();
  }

  override render() {
    const content = this.content;
    if (!content) return nothing;

    const lines = content.split("\n");
    const totalLines = lines.length;
    const truncated = totalLines > MAX_RENDER_LINES;
    const displayLines = truncated ? lines.slice(0, MAX_RENDER_LINES) : lines;
    const gutterWidth = String(truncated ? MAX_RENDER_LINES : totalLines).length;
    const wrap = shouldWrapLines(this.path);

    const baseLineCls = wrap
      ? "flex px-2 leading-5 font-mono"
      : "px-2 leading-5 font-mono whitespace-pre";
    const gutterCls = `select-none text-zinc-600 inline-block text-right border-r border-zinc-700/50 pr-2 mr-2 cursor-pointer hover:text-zinc-400${wrap ? " shrink-0" : ""}`;
    const contentCls = wrap
      ? "pl-3 whitespace-pre-wrap break-words min-w-0"
      : "pl-3";

    const hlStart = this.highlightRange?.startLine ?? -1;
    const hlEnd = this.highlightRange?.endLine ?? -1;

    return html`
      <div class="font-mono text-xs leading-5" @click=${this._onLineClick}>
        ${displayLines.map((line, i) => {
          const lineNo = i + 1;
          const lineHtml = this._highlight.getLineHtml(i);
          const inRange = lineNo >= hlStart && lineNo <= hlEnd;
          const lineCls = inRange
            ? `${baseLineCls} bg-yellow-500/15 shadow-[inset_2px_0_0_0_theme(colors.yellow.500)]`
            : `${baseLineCls} hover:bg-zinc-700/30`;
          return html`
            <div class="${lineCls}" data-line=${lineNo}><span class="${gutterCls}" data-gutter=${lineNo} style="min-width:${gutterWidth + 2}ch" @mousedown=${this._onGutterMouseDown}>${lineNo}</span><span class="${contentCls}">${lineHtml ? unsafeHTML(lineHtml) : line}</span></div>
          `;
        })}
        ${truncated
          ? html`<div class="px-4 py-3 text-center text-sm text-zinc-500 border-t border-zinc-700">
              Showing first ${MAX_RENDER_LINES.toLocaleString()} of ${totalLines.toLocaleString()} lines
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-code": FileViewerCode;
  }
}
