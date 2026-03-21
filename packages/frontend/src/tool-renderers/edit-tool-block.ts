/**
 * EditToolBlock — Lit component for rendering Edit tool calls with
 * lazy syntax highlighting on the inline diff.
 *
 * Highlighting is triggered only when the element scrolls into view
 * (IntersectionObserver), so old tool calls don't get highlighted on
 * chat load. Uses the shared HighlightController / Shiki web worker.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LazyHighlightController } from "../controllers/lazy-highlight-controller.js";
import { escapeHtml, shouldWrapLines } from "../changes/diff-utils.js";
import type { ToolBlockData } from "../chat-state.js";
import type { DiffLine } from "../changes/types.js";
import { getEditSummary, getEditStats, getEditDiffLines, shouldShowEditDiff, AUTO_EXPAND_THRESHOLD } from "./edit.js";

@customElement("edit-tool-block")
export class EditToolBlock extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _hl = new LazyHighlightController(this, () => {
    const path = getEditSummary(this.block);
    if (!path || this.block.isError) return null;
    const diffLines = getEditDiffLines(this.block);
    if (diffLines.length === 0) return null;
    return { path, hunk: { header: "", lines: diffLines } };
  });

  @property({ attribute: false })
  block!: ToolBlockData;

  @property({ type: Boolean })
  expanded = false;

  @property({ type: Boolean })
  showSpinner = false;

  @property({ attribute: false })
  onToggle: (() => void) | undefined;

  /** Tracks whether the user has manually collapsed an auto-expanded diff. */
  private _manuallyCollapsed = false;

  override connectedCallback() {
    super.connectedCallback();
    this._hl.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._hl.disconnect();
  }

  private _handleToggle = () => {
    const allDiffLines = getEditDiffLines(this.block);
    const isSmallDiff = allDiffLines.length > 0 && allDiffLines.length <= AUTO_EXPAND_THRESHOLD;
    if (isSmallDiff) {
      // Toggle internal collapsed state for auto-expanded diffs
      this._manuallyCollapsed = !this._manuallyCollapsed;
      this.requestUpdate();
    } else {
      // Delegate to external toggle for large diffs
      this.onToggle?.();
    }
  };

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("block") || changed.has("expanded")) {
      this._hl.update();
    }
  }

  private _renderHighlightedLine(index: number, text: string) {
    const highlighted = this._hl.getLineHtml(index);
    return highlighted ? unsafeHTML(highlighted) : escapeHtml(text);
  }

  private _renderDiffLine(line: DiffLine, index: number, wrap: boolean) {
    if (line.text === "⋯") {
      return html`<div class="px-3 py-0.5 text-zinc-600 text-center">⋯</div>`;
    }

    const bgCls =
      line.type === "remove"
        ? "bg-red-950/50"
        : line.type === "add"
          ? "bg-green-950/50"
          : "";

    const textCls =
      line.type === "remove"
        ? "text-red-300"
        : line.type === "add"
          ? "text-green-300"
          : "text-zinc-500";

    const prefix = line.type === "remove" ? "−" : line.type === "add" ? "+" : " ";
    const lineNo = line.type === "remove" ? line.oldLine : line.newLine;
    const content = this._renderHighlightedLine(index, line.text);
    const divCls = `${bgCls} leading-4 ${wrap ? "flex" : "whitespace-pre"}`;

    return html`<div class="${divCls}"><span class="select-none text-zinc-700 shrink-0 text-right mr-2 inline-block w-8">${lineNo ?? ""}</span><span class="select-none text-zinc-600 mr-1 shrink-0">${prefix}</span>${wrap ? html`<span class="${textCls} whitespace-pre-wrap break-words min-w-0">${content}</span>` : html`<span class="${textCls}">${content}</span>`}</div>`;
  }

  override render() {
    const path = getEditSummary(this.block);
    const isError = !!this.block.isError;
    const { additions, removals } = getEditStats(this.block);

    // Build stats badge
    const statsParts: string[] = [];
    if (additions > 0) statsParts.push(`+${additions}`);
    if (removals > 0) statsParts.push(`−${removals}`);
    const statsText = statsParts.join(" ");

    const borderColor = this.showSpinner
      ? "border-yellow-500/60"
      : isError
        ? "border-red-500/60"
        : "border-zinc-700";

    const wrap = shouldWrapLines(path || "");

    const showDiff = shouldShowEditDiff({
      block: this.block,
      expanded: this.expanded,
      manuallyCollapsed: this._manuallyCollapsed,
      showSpinner: this.showSpinner,
    });
    const diffLines = showDiff ? getEditDiffLines(this.block) : [];
    const hasDiff = diffLines.length > 0;
    // Auto-expanded small diffs get no height cap so wrapping doesn't cause nested scroll
    const isAutoExpanded = hasDiff && diffLines.length <= AUTO_EXPAND_THRESHOLD && !this.expanded;

    return html`
      <div class="mt-1 mb-1 ml-2 rounded-md bg-zinc-950 border ${borderColor} overflow-hidden">
        <!-- Header -->
        <div class="px-3 py-2 flex items-center gap-2 ${!this.showSpinner ? "cursor-pointer" : ""}" @click=${!this.showSpinner ? this._handleToggle : nothing}>
          ${this.showSpinner
            ? html`<span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>`
            : html`<span class="flex-shrink-0 text-xs">✏️</span>`}
          <span class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide flex-shrink-0">Edit</span>
          <span class="text-xs font-mono ${isError ? "text-red-400" : "text-zinc-300"} truncate">${path || "…"}</span>
          ${isError
            ? html`<span class="text-[10px] font-semibold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded flex-shrink-0">error</span>`
            : nothing}
          ${statsText
            ? html`<span class="text-[10px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">${statsText}</span>`
            : nothing}
        </div>

        <!-- Diff content (shown when expanded or auto-expanded for small diffs) -->
        ${hasDiff
          ? html`
              <div class="border-t border-zinc-800 px-1 py-1 text-xs font-mono ${isAutoExpanded ? "" : "max-h-96 overflow-y-auto"} overflow-x-auto">
                <div class="${wrap ? "" : "w-fit min-w-full"}">
                ${diffLines.map((line, i) => this._renderDiffLine(line, i, wrap))}
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
    "edit-tool-block": EditToolBlock;
  }
}
