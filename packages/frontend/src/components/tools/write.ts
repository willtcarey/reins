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
import { LazyHighlightController } from "../../controllers/lazy-highlight-controller.js";
import { shouldWrapLines } from "../../models/changes/diff-utils.js";
import { openInBrowserEvent } from "../events.js";
import { isBrowsablePath, toRelativePath } from "../../models/path-utils.js";
import type { ToolRenderer } from "./types.js";
import type { Source } from "@reins/sdk";
import { ringSpinnerIcon } from "../../ui/icons.js";
import type { ToolBlockData } from "../../models/chat-state.js";
import { getWriteSummary, getWriteInfo, getWriteContent, getWriteTail } from "../../models/tools/write.js";
import { PREVIEW_LINES } from "./live-lines.js";

@customElement("write-tool-block")
export class WriteToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _hl = new LazyHighlightController(this, () => {
    // Content still being written would be highlighted again on every frame.
    if (!this.path || !this.content || this.isError || this.partialArgs) return null;
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
  source: Source | null = null;

  @property({ attribute: false })
  content = "";

  @property({ type: Number })
  lineCount = 0;

  /** The file line `content` starts at: while it is written, only its tail is given. */
  @property({ type: Number })
  startLine = 1;

  @property({ type: Boolean })
  isError = false;

  @state()
  private expanded = false;

  @property({ type: Boolean })
  showSpinner = false;

  /** Its arguments are still being written: its path may be cut short, so it links nowhere yet. */
  @property({ type: Boolean })
  partialArgs = false;

  override connectedCallback() {
    super.connectedCallback();
    this._hl.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._hl.disconnect();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("content") || changed.has("path") || changed.has("isError") || changed.has("partialArgs")) {
      this._hl.update();
    }
  }

  private _toggle = () => {
    this.expanded = !this.expanded;
  };

  /** Open this file in the file browser overlay. */
  private _openInBrowser = (e: Event) => {
    e.stopPropagation();
    if (!this.source || !this.path || !isBrowsablePath(this.path, this.source.path)) return;
    this.dispatchEvent(openInBrowserEvent(this.source, this.path));
  };

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._hl.getLineHtml(index);
    // Lit escapes plain strings. Pre-escaping here would display entities such
    // as `&lt;` until asynchronous highlighting replaces the fallback.
    return highlighted ? unsafeHTML(highlighted) : text;
  }

  private _renderContentLine(index: number, text: string, colorCls: string, wrap: boolean) {
    const content = this._renderHighlightedLine(index, text);
    const divCls = `bg-green-950/50 leading-4 ${wrap ? "flex" : "whitespace-pre"}`;
    return html`<div class="${divCls}"><span class="select-none text-zinc-700 shrink-0 text-right mr-2 inline-block w-8">${this.startLine + index}</span><span class="select-none text-zinc-600 mr-1 shrink-0">+</span>${wrap ? html`<span class="${colorCls} whitespace-pre-wrap break-words min-w-0">${content}</span>` : html`<span class="${colorCls}">${content}</span>`}</div>`;
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
    const canInteract = hasContent;

    // When collapsed, the entire card is clickable to expand.
    // When expanded, only the header is clickable to collapse.
    const cardClickable = canInteract && !this.expanded;
    const headerClickable = canInteract && this.expanded;

    const contentColorCls = this.isError ? "text-red-400" : "text-green-300";
    const previewColorCls = this.isError ? "text-red-400" : "text-green-400/70";
    const wrap = shouldWrapLines(this.path || "");
    const inProject = isBrowsablePath(this.path, this.source?.path ?? null);
    const browsable = !this.partialArgs && inProject;

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
            ? ringSpinnerIcon("inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0")
            : html`<span class="flex-shrink-0 text-xs">📝</span>`}
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide flex-shrink-0">Write</span>
          <span
            class="text-xs font-mono ${this.isError ? "text-red-400" : "text-zinc-300"} truncate ${browsable ? "hover:underline cursor-pointer" : ""}"
            @click=${browsable ? this._openInBrowser : nothing}
            title=${browsable ? "Open in file browser" : this.partialArgs ? nothing : "Outside project directory"}
          >${this.path || "…"}</span>
          ${this.path && !this.partialArgs && !inProject
            ? html`<span class="text-[10px] font-mono text-zinc-600 bg-zinc-800/60 px-1.5 py-0.5 rounded flex-shrink-0">external</span>`
            : nothing}
          ${this.isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${!this.showSpinner && hasMore && !this.expanded
            ? html`<span class="text-[10px] text-zinc-600 flex-shrink-0 ml-auto">${this.lineCount} lines</span>`
            : nothing}
        </div>

        <!-- Content: its newest lines while it is written, its first ones after; all of it when expanded.
             A new renderLine each render, so lines highlighted since are drawn again. -->
        ${hasContent ? html`<live-lines
          .lines=${contentLines}
          .renderLine=${(line: string, index: number, preview: boolean) => this._renderContentLine(index, line, preview ? previewColorCls : contentColorCls, wrap && !preview)}
          .preview=${this.partialArgs ? "newest" : "first"}
          .expanded=${this.expanded}
          .wrap=${wrap}
        ></live-lines>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "write-tool-block": WriteToolBlock;
  }
}

// ---------------------------------------------------------------------------
// Renderer — extracts all data and passes primitives to <write-tool-block>
// ---------------------------------------------------------------------------

export const writeRenderer: ToolRenderer = {
  render(block: ToolBlockData, context) {
    const path = toRelativePath(getWriteSummary(block), context.source?.path ?? null);
    const { content, startLine } = block.partialArgs ? getWriteTail(block) : { content: getWriteContent(block), startLine: 1 };
    const { lines: lineCount } = getWriteInfo(block);
    const isError = !!block.isError;
    return html`<write-tool-block
      .path=${path}
      .source=${context.source}
      .content=${content}
      .lineCount=${lineCount}
      .startLine=${startLine}
      .isError=${isError}
      .showSpinner=${block.status === "running"}
      .partialArgs=${!!block.partialArgs}
    ></write-tool-block>`;
  },
};
