/**
 * WriteToolBlock — Lit component for rendering Write tool calls with
 * lazy syntax highlighting.
 *
 * Card-style block matching edit-tool-block: file path + line count badge.
 * When expanded, shows syntax-highlighted content preview.
 *
 * Pure presentational component — receives all data as primitive props.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LazyHighlightController } from "../controllers/lazy-highlight-controller.js";
import { escapeHtml, shouldWrapLines } from "../models/changes/diff-utils.js";

const PREVIEW_LINES = 4;

@customElement("write-tool-block")
export class WriteToolBlock extends LitElement {
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
          type: "add" as const,
          text,
          newLine: i + 1,
        })),
      },
    };
  });

  @property({ attribute: false })
  path = "";

  @property({ attribute: false })
  content = "";

  @property({ type: Number })
  lineCount = 0;

  @property({ type: Boolean })
  isError = false;

  @state()
  private expanded = false;

  @property({ type: Boolean })
  showSpinner = false;

  override connectedCallback() {
    super.connectedCallback();
    this._hl.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._hl.disconnect();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("content") || changed.has("path") || changed.has("isError")) {
      this._hl.update();
    }
  }

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._hl.getLineHtml(index);
    return highlighted ? unsafeHTML(highlighted) : escapeHtml(text);
  }

  private _renderContentLine(index: number, text: string, colorCls: string, wrap: boolean) {
    const content = this._renderHighlightedLine(index, text);
    const divCls = `bg-green-950/50 leading-4 ${wrap ? "flex" : "whitespace-pre"}`;
    return html`<div class="${divCls}"><span class="select-none text-zinc-700 shrink-0 text-right mr-2 inline-block w-8">${index + 1}</span><span class="select-none text-zinc-600 mr-1 shrink-0">+</span>${wrap ? html`<span class="${colorCls} whitespace-pre-wrap break-words min-w-0">${content}</span>` : html`<span class="${colorCls}">${content}</span>`}</div>`;
  }

  override render() {
    const borderColor = this.showSpinner
      ? "border-yellow-500/60"
      : this.isError
        ? "border-red-500/60"
        : "border-zinc-700";

    const hasContent = !!this.content.trim();
    const contentLines = this.content ? this.content.split("\n") : [];
    const hasMore = contentLines.length > PREVIEW_LINES;
    const previewLines = contentLines.slice(0, PREVIEW_LINES);
    const canInteract = !this.showSpinner && hasContent;

    // When collapsed, the entire card is clickable to expand.
    // When expanded, only the header is clickable to collapse.
    const cardClickable = canInteract && !this.expanded;
    const headerClickable = canInteract && this.expanded;

    const contentColorCls = this.isError ? "text-red-400" : "text-green-300";
    const previewColorCls = this.isError ? "text-red-400" : "text-green-400/70";
    const wrap = shouldWrapLines(this.path || "");

    return html`
      <div
        class="mt-1 mb-1 ml-2 rounded-lg bg-zinc-950 border ${borderColor} overflow-hidden ${cardClickable ? "cursor-pointer" : ""}"
        @click=${cardClickable ? this._toggle : nothing}
      >
        <!-- Header -->
        <div
          class="px-3 py-2 flex items-center gap-2 ${headerClickable ? "cursor-pointer" : ""}"
          @click=${headerClickable ? (e: Event) => { e.stopPropagation(); this._toggle(); } : nothing}
        >
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="flex-shrink-0 text-xs">📝</span>`}
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide flex-shrink-0">Write</span>
          <span class="text-xs font-mono ${this.isError ? "text-red-400" : "text-zinc-300"} truncate">${this.path || "…"}</span>
          ${this.isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${!this.showSpinner && hasMore && !this.expanded
            ? html`<span class="text-[10px] text-zinc-600 flex-shrink-0 ml-auto">${this.lineCount} lines</span>`
            : nothing}
        </div>

        <!-- Preview (collapsed, first few lines) -->
        ${!this.expanded && hasContent
          ? html`
              <div class="border-t border-zinc-800 px-1 py-1 text-xs font-mono overflow-x-auto">
                <div class="${wrap ? "" : "w-fit min-w-full"}">
                ${previewLines.map((line, i) => this._renderContentLine(i, line, previewColorCls, wrap))}
                ${hasMore
                  ? html`<div class="flex leading-4"><span class="select-none text-zinc-700 shrink-0 text-right mr-2 inline-block w-8"></span><span class="text-zinc-700 ml-1">…</span></div>`
                  : nothing}
                </div>
              </div>
            `
          : nothing}

        <!-- Full content (expanded) -->
        ${this.expanded && hasContent
          ? html`
              <div class="border-t border-zinc-800 px-1 py-1 text-xs font-mono max-h-64 overflow-y-auto overflow-x-auto">
                <div class="${wrap ? "" : "w-fit min-w-full"}">
                ${contentLines.map((line, i) => this._renderContentLine(i, line, contentColorCls, wrap))}
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "write-tool-block": WriteToolBlock;
  }
}
