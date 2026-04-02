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
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("content") || changed.has("path")) {
      this._highlight.update();
    }
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

    const lineCls = wrap
      ? "flex px-2 leading-5 font-mono hover:bg-zinc-700/30"
      : "px-2 leading-5 font-mono whitespace-pre hover:bg-zinc-700/30";
    const gutterCls = `select-none text-zinc-600 inline-block text-right border-r border-zinc-700/50 pr-2 mr-2${wrap ? " shrink-0" : ""}`;
    const contentCls = wrap
      ? "pl-3 whitespace-pre-wrap break-words min-w-0"
      : "pl-3";

    return html`
      <div class="font-mono text-xs leading-5">
        ${displayLines.map((line, i) => {
          const lineHtml = this._highlight.getLineHtml(i);
          return html`
            <div class="${lineCls}"><span class="${gutterCls}" style="min-width:${gutterWidth + 2}ch">${i + 1}</span><span class="${contentCls}">${lineHtml ? unsafeHTML(lineHtml) : line}</span></div>
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
