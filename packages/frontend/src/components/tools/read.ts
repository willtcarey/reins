/**
 * ReadToolBlock — Lit component for rendering Read tool calls with
 * lazy syntax highlighting.
 *
 * Pure presentational component — receives all data as primitive props
 * from the renderer (read.ts). Has no knowledge of ToolBlockData.
 *
 * Highlighting is triggered only when the element scrolls into view
 * (IntersectionObserver), so old tool calls don't get highlighted on
 * chat load. Uses the shared HighlightController / Shiki web worker.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LazyHighlightController } from "../../controllers/lazy-highlight-controller.js";
import { escapeHtml, shouldWrapLines } from "../../models/changes/diff-utils.js";
import type { ToolResultImage } from "./types.js";
import { imageBlockSrc } from "../../models/chat-content.js";
import { openInBrowserEvent } from "../events.js";
import { isBrowsablePath, toRelativePath } from "../../models/path-utils.js";
import type { ToolRenderer } from "./types.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import {
  getReadSummary, getReadRange, getReadTrailer, getReadPreview,
  getReadContent, getReadLineCount, getReadImages, PREVIEW_LINES,
} from "../../models/tools/read.js";

@customElement("read-tool-block")
export class ReadToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _hl = new LazyHighlightController(this, () => {
    if (!this.path || !this.content || this.isError) return null;
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

  @property({ attribute: false })
  path = "";

  @property({ attribute: false })
  range = "";

  @property({ attribute: false })
  trailer = "";

  @property({ attribute: false })
  preview = "";

  @property({ attribute: false })
  content = "";

  @property({ type: Number })
  totalLines = 0;

  @property({ type: Number })
  startLine = 1;

  @property({ type: Boolean })
  isError = false;

  @property({ attribute: false })
  images: ToolResultImage[] = [];

  @property({ attribute: false })
  sessionId = "";

  @property({ type: Boolean })
  showSpinner = false;

  @state()
  private expanded = false;

  override connectedCallback() {
    super.connectedCallback();
    this._hl.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._hl.disconnect();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("content") || changed.has("path")) {
      this._hl.update();
    }
  }

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  /** Open this file in the file browser overlay, highlighting the read range. */
  private _openInBrowser = (e: Event) => {
    e.stopPropagation();
    if (!this.path || !isBrowsablePath(this.path)) return;
    // Only highlight when a specific range was read (offset/limit specified).
    // Reading the full file doesn't benefit from highlighting every line.
    const lineRange = this.range && this.totalLines > 0
      ? { startLine: this.startLine, endLine: this.startLine + this.totalLines - 1 }
      : undefined;
    this.dispatchEvent(openInBrowserEvent(this.path, lineRange));
  };

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._hl.getLineHtml(index);
    return highlighted ? unsafeHTML(highlighted) : escapeHtml(text);
  }

  /** Render a line with a gutter line number. */
  private _renderGutteredLine(index: number, text: string, lineNo: number, gutterCh: number, colorCls: string, wrap: boolean) {
    const content = this._renderHighlightedLine(index, text);
    const divCls = wrap ? "flex" : "whitespace-pre";
    return html`<div class="${divCls}"><span class="select-none text-zinc-700 shrink-0 text-right mr-3 inline-block" style="width:${gutterCh}ch">${lineNo}</span>${wrap ? html`<span class="${colorCls} whitespace-pre-wrap break-words min-w-0">${content}</span>` : html`<span class="${colorCls}">${content}</span>`}</div>`;
  }

  override render() {
    const { path, range, trailer, isError, preview, content: fullContent, totalLines, images, startLine } = this;

    const borderColor = isError
      ? "border-red-500/60"
      : this.showSpinner
        ? "border-yellow-500/60"
        : "border-zinc-700";

    const hasContent = !!fullContent?.trim();
    const hasPreview = !!preview?.trim();
    const canInteract =
      !this.showSpinner && (hasContent || images.length > 0);
    const previewLines = preview?.split("\n").length ?? 0;
    const hasMore = totalLines > previewLines;

    // When collapsed, the entire card is clickable to expand.
    // When expanded, only the header is clickable to collapse.
    const cardClickable = canInteract && !this.expanded;
    const headerClickable = canInteract && this.expanded;

    // Build content lines arrays for highlighting
    const previewLineTexts = preview ? preview.split("\n") : [];
    const fullLineTexts = fullContent ? fullContent.split("\n") : [];

    // Line numbering
    const lastLine = startLine + totalLines - 1;
    const gutterCh = Math.max(String(lastLine).length, 3);
    const contentColorCls = isError ? "text-red-400" : "text-zinc-400";
    const previewColorCls = isError ? "text-red-400" : "text-zinc-500";
    const wrap = shouldWrapLines(path || "");

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg bg-zinc-950 border ${borderColor} overflow-hidden ${cardClickable ? "cursor-pointer" : ""}"
        @click=${cardClickable ? this._toggle : nothing}
      >
        <!-- Header: file path -->
        <div
          class="px-3 py-2 flex items-center gap-2 ${headerClickable ? "cursor-pointer" : ""}"
          @click=${headerClickable ? (e: Event) => { e.stopPropagation(); this._toggle(); } : nothing}
        >
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="flex-shrink-0 text-xs">📄</span>`}
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide flex-shrink-0">Read</span>
          <span
            class="text-xs font-mono ${isError ? "text-red-400" : "text-zinc-300"} truncate ${isBrowsablePath(path) ? "hover:underline cursor-pointer" : ""}"
            @click=${isBrowsablePath(path) ? this._openInBrowser : nothing}
            title=${isBrowsablePath(path) ? "Open in file browser" : "Outside project directory"}
          >${path || "…"}</span>
          ${path && !isBrowsablePath(path)
            ? html`<span class="text-[10px] font-mono text-zinc-600 bg-zinc-800/60 px-1.5 py-0.5 rounded flex-shrink-0">external</span>`
            : nothing}
          ${range
            ? html`<span class="text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">${range}</span>`
            : nothing}
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${!this.showSpinner && hasMore && !this.expanded
            ? html`<span class="text-[10px] text-zinc-600 flex-shrink-0 ml-auto">${totalLines} lines</span>`
            : nothing}
        </div>

        <!-- Preview area (shown when collapsed and content exists) -->
        ${!this.expanded && hasPreview
          ? html`
              <div class="border-t border-zinc-800 px-3 py-2 text-xs font-mono overflow-x-auto">
                <div class="${wrap ? "" : "w-fit min-w-full"}">
                ${previewLineTexts.map(
                  (line, i) => this._renderGutteredLine(i, line, startLine + i, gutterCh, previewColorCls, wrap),
                )}
                ${hasMore ? html`<div class="flex"><span class="select-none text-zinc-700 shrink-0 text-right mr-3 inline-block" style="width:${gutterCh}ch"></span><span class="text-zinc-700">…</span></div>` : nothing}
                ${trailer ? html`<div class="mt-1 text-[10px] text-zinc-600 italic">${trailer}</div>` : nothing}
                </div>
              </div>
            `
          : nothing}

        <!-- Full content area (shown when expanded) -->
        ${this.expanded && hasContent
          ? html`
              <div class="border-t border-zinc-800 px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto overflow-x-auto">
                <div class="${wrap ? "" : "w-fit min-w-full"}">
                ${fullLineTexts.map(
                  (line, i) => this._renderGutteredLine(i, line, startLine + i, gutterCh, contentColorCls, wrap),
                )}
                ${trailer ? html`<div class="mt-1 text-[10px] text-zinc-600 italic">${trailer}</div>` : nothing}
                </div>
              </div>
            `
          : nothing}

        <!-- No content message -->
        ${!this.showSpinner && !hasContent && !this.expanded
          ? html`
              <div class="border-t border-zinc-800 px-3 py-2">
                <span class="text-xs text-zinc-600 italic">No content</span>
              </div>
            `
          : nothing}

        <!-- Images -->
        ${images.length > 0 && (this.expanded || !hasContent)
          ? html`
              <div class="border-t border-zinc-800 p-2">
                ${images.map(
                  (img) =>
                    html`<img
                      src=${imageBlockSrc(this.sessionId, img)}
                      class="max-w-full max-h-96 rounded mt-1"
                      alt="Tool result image"
                    />`,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "read-tool-block": ReadToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <read-tool-block>
// ---------------------------------------------------------------------------

export const readRenderer: ToolRenderer = {
  render(block: ToolBlockData) {
    const isRunning = block.status === "running";
    const path = toRelativePath(getReadSummary(block));
    const range = getReadRange(block);
    const trailer = isRunning ? "" : getReadTrailer(block);
    const preview = isRunning ? "" : getReadPreview(block, PREVIEW_LINES);
    const content = isRunning ? "" : getReadContent(block);
    const totalLines = isRunning ? 0 : getReadLineCount(block);
    const startLine = (typeof block.args?.offset === "number" ? block.args.offset : undefined) ?? 1;
    const isError = !isRunning && !!block.isError;
    const images = isRunning ? [] : getReadImages(block);

    return html`<read-tool-block
      .path=${path}
      .range=${range}
      .trailer=${trailer}
      .preview=${preview}
      .content=${content}
      .totalLines=${totalLines}
      .startLine=${startLine}
      .isError=${isError}
      .images=${images}
      .sessionId=${block.sessionId ?? ""}
      .showSpinner=${isRunning}
    ></read-tool-block>`;
  },
};
