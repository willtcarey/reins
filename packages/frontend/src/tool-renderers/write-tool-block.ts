/**
 * WriteToolBlock — Lit component for rendering Write tool calls with
 * lazy syntax highlighting.
 *
 * Card-style block matching edit-tool-block: file path + line count badge.
 * When expanded, shows syntax-highlighted content preview.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { HighlightController } from "../controllers/highlight-controller.js";
import { escapeHtml } from "../changes/diff-utils.js";
import type { ToolBlockData } from "../chat-state.js";
import type { DiffHunk, DiffLine } from "../changes/types.js";
import { getWriteSummary, getWriteInfo } from "./write.js";

@customElement("write-tool-block")
export class WriteToolBlock extends LitElement {
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
    const path = getWriteSummary(this.block);
    const content = this._getContent();
    if (!path || !content || this.block.isError) return;

    if (path === this._lastPath && content === this._lastContent) return;
    this._lastPath = path;
    this._lastContent = content;

    const lines = content.split("\n");
    const hunk: DiffHunk = {
      header: "",
      lines: lines.map(
        (text, i): DiffLine => ({
          type: "add",
          text,
          newLine: i + 1,
        }),
      ),
    };
    this._highlight.setHunk(path, hunk);
  }

  private _getContent(): string {
    const content = this.block.args?.content;
    if (!content || typeof content !== "string") return "";
    return content.length > 5000 ? content.slice(0, 5000) + "\n…(truncated)" : content;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (this._hasBeenVisible && changed.has("block")) {
      this._triggerHighlight();
    }
  }

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._highlight.getLineHtml(index);
    return highlighted ? unsafeHTML(highlighted) : escapeHtml(text);
  }

  override render() {
    const path = getWriteSummary(this.block);
    const isError = !!this.block.isError;
    const { lines: lineCount } = getWriteInfo(this.block);
    const lineLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;

    const borderColor = this.showSpinner
      ? "border-yellow-500/60"
      : isError
        ? "border-red-500/60"
        : "border-zinc-700";

    const content = this._getContent();
    const hasContent = !!content.trim();
    const clickable = !this.showSpinner && hasContent;
    const contentLines = content ? content.split("\n") : [];
    const gutterCh = Math.max(String(contentLines.length).length, 3);

    return html`
      <div class="mt-1 mb-1 ml-2 rounded-md bg-zinc-950 border ${borderColor} overflow-hidden">
        <!-- Header -->
        <div class="px-3 py-2 flex items-center gap-2 ${clickable ? "cursor-pointer" : ""}" @click=${clickable ? this.onToggle : nothing}>
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="flex-shrink-0 text-xs">📝</span>`}
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide flex-shrink-0">Write</span>
          <span class="text-xs font-mono ${isError ? "text-red-400" : "text-zinc-300"} truncate">${path || "…"}</span>
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${lineCount > 0
            ? html`<span class="text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">${lineLabel}</span>`
            : nothing}
        </div>

        <!-- Content (expanded) -->
        ${this.expanded && hasContent
          ? html`
              <div class="border-t border-zinc-800 px-1 py-1 text-xs font-mono max-h-64 overflow-y-auto overflow-x-auto">
                ${contentLines.map(
                  (line, i) => html`<div class="flex bg-green-950/50 leading-4"><span class="select-none text-zinc-700 shrink-0 text-right mr-2 inline-block w-8">${i + 1}</span><span class="select-none text-zinc-600 mr-1 shrink-0">+</span><span class="text-green-300 whitespace-pre overflow-x-auto min-w-0">${this._renderHighlightedLine(i, line)}</span></div>`,
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
    "write-tool-block": WriteToolBlock;
  }
}
