/**
 * ReadToolBlock — Lit component for rendering Read tool calls with
 * lazy syntax highlighting.
 *
 * Highlighting is triggered only when the element scrolls into view
 * (IntersectionObserver), so old tool calls don't get highlighted on
 * chat load. Uses the shared HighlightController / Shiki web worker.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { HighlightController } from "../controllers/highlight-controller.js";
import { escapeHtml } from "../changes/diff-utils.js";
import type { ToolBlockData } from "../chat-state.js";
import type { DiffHunk, DiffLine } from "../changes/types.js";
import {
  getReadSummary,
  getReadPreview,
  getReadContent,
  getReadLineCount,
  getReadRange,
  getReadTrailer,
} from "./read.js";

const PREVIEW_LINES = 4;

@customElement("read-tool-block")
export class ReadToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _highlight = new HighlightController(this);
  private _observer: IntersectionObserver | null = null;
  private _hasBeenVisible = false;
  private _lastContent = "";
  private _lastPath = "";

  @property({ attribute: false })
  block!: ToolBlockData;

  @property({ type: Boolean })
  expanded = false;

  @property({ type: Boolean })
  showSpinner = false;

  @property({ attribute: false })
  onToggle: (() => void) | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this._setupObserver();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._observer?.disconnect();
    this._observer = null;
  }

  private _setupObserver() {
    if (this._hasBeenVisible) return;
    this._observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this._hasBeenVisible = true;
            this._observer?.disconnect();
            this._observer = null;
            this._triggerHighlight();
            break;
          }
        }
      },
      { threshold: 0 },
    );
    this._observer.observe(this);
  }

  private _triggerHighlight() {
    const path = getReadSummary(this.block);
    const content = getReadContent(this.block);
    if (!path || !content || this.block.isError) return;

    // Skip if content hasn't changed — avoids clearing highlighted HTML
    // and re-requesting from the worker, which causes a flash in Safari.
    if (path === this._lastPath && content === this._lastContent) return;
    this._lastPath = path;
    this._lastContent = content;

    const lines = content.split("\n");
    const hunk = this._buildHunk(lines);
    this._highlight.setHunk(path, hunk);
  }

  private _buildHunk(lines: string[]): DiffHunk {
    return {
      header: "",
      lines: lines.map(
        (text, i): DiffLine => ({
          type: "context",
          text,
          newLine: i + 1,
        }),
      ),
    };
  }

  override willUpdate(changed: Map<string, unknown>) {
    // Re-trigger highlighting if block changes while already visible
    if (this._hasBeenVisible && changed.has("block")) {
      this._triggerHighlight();
    }
  }

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._highlight.getLineHtml(index);
    return highlighted ? unsafeHTML(highlighted) : escapeHtml(text);
  }

  /** Render a line with a gutter line number. */
  private _renderGutteredLine(index: number, text: string, lineNo: number, gutterCh: number, colorCls: string) {
    return html`<div class="flex"><span class="select-none text-zinc-700 shrink-0 text-right mr-3 inline-block" style="width:${gutterCh}ch">${lineNo}</span><span class="${colorCls} whitespace-pre-wrap break-words min-w-0">${this._renderHighlightedLine(index, text)}</span></div>`;
  }

  override render() {
    const path = getReadSummary(this.block);
    const range = getReadRange(this.block);
    const trailer = getReadTrailer(this.block);
    const isError = !!this.block.isError;
    const preview = getReadPreview(this.block, PREVIEW_LINES);
    const fullContent = getReadContent(this.block);
    const totalLines = getReadLineCount(this.block);
    const images =
      this.block.result?.content?.filter(
        (c): c is { type: "image"; data: string; mimeType: string } =>
          c.type === "image",
      ) ?? [];

    const borderColor = isError
      ? "border-red-500/60"
      : this.showSpinner
        ? "border-yellow-500/60"
        : "border-zinc-700";

    const hasContent = !!fullContent?.trim();
    const hasPreview = !!preview?.trim();
    const clickable =
      !this.showSpinner && (hasContent || images.length > 0);
    const previewLines = preview?.split("\n").length ?? 0;
    const hasMore = totalLines > previewLines;

    // Build content lines arrays for highlighting
    const previewLineTexts = preview ? preview.split("\n") : [];
    const fullLineTexts = fullContent ? fullContent.split("\n") : [];

    // Line numbering: start from offset arg (1-indexed) or 1
    const startLine = (this.block.args?.offset as number | undefined) ?? 1;
    const lastLine = startLine + totalLines - 1;
    const gutterCh = Math.max(String(lastLine).length, 3);
    const contentColorCls = isError ? "text-red-400" : "text-zinc-400";
    const previewColorCls = isError ? "text-red-400" : "text-zinc-500";

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-md bg-zinc-950 border ${borderColor} overflow-hidden"
      >
        <!-- Header: file path (clickable to toggle) -->
        <div class="px-3 py-2 flex items-center gap-2 ${clickable ? "cursor-pointer" : ""}" @click=${clickable ? this.onToggle : nothing}>
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="flex-shrink-0 text-xs">📄</span>`}
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide flex-shrink-0">Read</span>
          <span class="text-xs font-mono ${isError ? "text-red-400" : "text-zinc-300"} truncate">${path || "…"}</span>
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
              <div class="border-t border-zinc-800 px-3 py-2 text-xs font-mono">
                ${previewLineTexts.map(
                  (line, i) => this._renderGutteredLine(i, line, startLine + i, gutterCh, previewColorCls),
                )}
                ${hasMore ? html`<div class="flex"><span class="select-none text-zinc-700 shrink-0 text-right mr-3 inline-block" style="width:${gutterCh}ch"></span><span class="text-zinc-700">…</span></div>` : nothing}
                ${trailer ? html`<div class="mt-1 text-[10px] text-zinc-600 italic">${trailer}</div>` : nothing}
              </div>
            `
          : nothing}

        <!-- Full content area (shown when expanded) -->
        ${this.expanded && hasContent
          ? html`
              <div class="border-t border-zinc-800 px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto">
                ${fullLineTexts.map(
                  (line, i) => this._renderGutteredLine(i, line, startLine + i, gutterCh, contentColorCls),
                )}
                ${trailer ? html`<div class="mt-1 text-[10px] text-zinc-600 italic">${trailer}</div>` : nothing}
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
                      src="data:${img.mimeType};base64,${img.data}"
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
