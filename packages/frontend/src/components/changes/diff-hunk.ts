/**
 * Diff Hunk
 *
 * Lit component that renders a single diff hunk: its separator/expand-up
 * button, hunk header, diff lines, and trailer/expand-down button.
 *
 * Events emitted:
 *  - `expand-up`   (detail: { filePath, hunkIndex }) — expand context above
 *  - `expand-down` (detail: { filePath, hunkIndex }) — expand context below
 *
 * The parent (`<diff-file-card>`) is responsible for passing the right
 * properties and wiring the expand events to the DiffStore.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { DiffFile, DiffHunk as DiffHunkType, DiffLine } from "../../models/changes/types.js";
import { LazyHighlightController } from "../../controllers/lazy-highlight-controller.js";
import { EXPAND_STEP, escapeHtml, getHunkEndLine } from "../../models/changes/diff-utils.js";

export interface ExpandDetail {
  filePath: string;
  hunkIndex: number;
}

@customElement("diff-hunk")
export class DiffHunk extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Highlights this hunk when it scrolls into view. */
  private _highlight = new LazyHighlightController(this, () => {
    const hunk = this.file?.hunks[this.hunkIndex];
    if (!hunk || !this.file) return null;
    return { path: this.file.path, hunk };
  });

  /** The parent file — needed for separator gap calculations and language detection. */
  @property({ attribute: false })
  file!: DiffFile;

  /** Index of this hunk within the file's hunks array. */
  @property({ type: Number })
  hunkIndex = 0;

  /** Character width for the line-number gutter. */
  @property({ type: Number })
  gutterCh = 4;

  /** Whether to word-wrap lines (used for markdown files). */
  @property({ type: Boolean })
  wrap = false;

  /** Set of expanding-hunk keys currently loading. */
  @property({ attribute: false })
  expandingHunks: Set<string> = new Set();

  override connectedCallback() {
    super.connectedCallback();
    this._highlight.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._highlight.disconnect();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("file") || changed.has("hunkIndex")) {
      this._highlight.update();
    }
  }

  // ---- Rendering helpers ----------------------------------------------------

  private get hunk(): DiffHunkType {
    return this.file.hunks[this.hunkIndex];
  }

  private renderLine(line: DiffLine, index: number) {
    let prefix = "\u00a0";
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
        prefix = "\u00a0";
        classes = "text-zinc-400";
        break;
    }

    const content = unsafeHTML(this._highlight.getLineHtml(index) ?? escapeHtml(line.text));
    const divCls = `${classes} px-2 leading-5 font-mono ${this.wrap ? "flex" : "whitespace-pre"}`;
    const gutterCls = `select-none text-zinc-600 ${this.wrap ? "shrink-0" : ""}`;

    return html`<div class=${divCls}><span class="${gutterCls} mr-1 inline-block text-right" style="width:${this.gutterCh}ch">${lineNo ?? ""}</span><span class="${gutterCls} mr-2 inline-block text-center" style="width:1ch">${prefix}</span>${this.wrap ? html`<span class="whitespace-pre-wrap break-words min-w-0">${content}</span>` : content}</div>`;
  }

  private renderExpandButton(label: string, onClick: () => void, loading = false, direction: "up" | "down" | "both" = "down") {
    const padCh = this.gutterCh + 2;
    let directionLabel: string;
    switch (direction) {
      case "both":
        directionLabel = "↕";
        break;
      case "up":
        directionLabel = "↑";
        break;
      case "down":
        directionLabel = "↓";
        break;
    }
    return html`
      <button
        class="w-full py-1.5 sm:py-1 text-xs text-zinc-300 bg-zinc-800/70 hover:text-zinc-100 hover:bg-zinc-700/70 cursor-pointer flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style="padding-left:${padCh}ch"
        ?disabled=${loading}
        @click=${onClick}
      >
        ${this.renderExpandIndicator(loading, directionLabel)}
        <span>${label}</span>
      </button>
    `;
  }

  private renderExpandIndicator(loading: boolean, directionLabel: string) {
    return loading
      ? html`<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>`
      : html`<span class="font-mono text-zinc-400">${directionLabel}</span>`;
  }

  private _fireExpand(direction: "up" | "down", hunkIdx: number) {
    const eventName = direction === "up" ? "expand-up" : "expand-down";
    this.dispatchEvent(new CustomEvent<ExpandDetail>(eventName, {
      bubbles: true,
      composed: true,
      detail: { filePath: this.file.path, hunkIndex: hunkIdx },
    }));
  }

  // ---- Separator (expand-up / gap buttons above this hunk) ------------------

  renderSeparator() {
    const nextHunk = this.hunk;
    const prevHunkIndex = this.hunkIndex > 0 ? this.hunkIndex - 1 : null;

    if (prevHunkIndex === null) {
      // First hunk — check if there are hidden lines above
      const firstLine = nextHunk.lines[0];
      const startLine = firstLine?.newLine ?? firstLine?.oldLine ?? 1;
      if (startLine > 1) {
        const key = `${this.file.path}:${this.hunkIndex}:up`;
        const loading = this.expandingHunks.has(key);
        return this.renderExpandButton(
          `Show ${Math.min(EXPAND_STEP, startLine - 1)} more line${startLine - 1 !== 1 ? "s" : ""} above`,
          () => this._fireExpand("up", this.hunkIndex),
          loading,
          "up",
        );
      }
      return nothing;
    }

    const prevHunk = this.file.hunks[prevHunkIndex];

    // Calculate gap between hunks
    const prevLastLine = getHunkEndLine(prevHunk);
    const nextFirstLine = nextHunk.lines[0]?.newLine ?? nextHunk.lines[0]?.oldLine ?? 0;
    const gap = nextFirstLine - prevLastLine - 1;
    if (gap > 0) {
      const upKey = `${this.file.path}:${this.hunkIndex}:up`;
      const downKey = `${this.file.path}:${prevHunkIndex}:down`;
      const loading = this.expandingHunks.has(upKey) || this.expandingHunks.has(downKey);
      if (gap <= EXPAND_STEP) {
        return this.renderExpandButton(
          `Expand ${gap} hidden line${gap !== 1 ? "s" : ""}`,
          () => this._fireExpand("up", this.hunkIndex),
          loading,
          "both",
        );
      }
      return this.renderExpandButton(
        `Show ${EXPAND_STEP} of ${gap} hidden lines above`,
        () => this._fireExpand("up", this.hunkIndex),
        loading,
        "up",
      );
    }

    return nothing;
  }

  // ---- Trailer (expand-down button below this hunk) -------------------------

  renderTrailer() {
    const hunk = this.hunk;
    const lastLine = getHunkEndLine(hunk);

    if (this.hunkIndex < this.file.hunks.length - 1) {
      const nextHunk = this.file.hunks[this.hunkIndex + 1];
      const nextFirstLine = nextHunk.lines[0]?.newLine ?? nextHunk.lines[0]?.oldLine ?? 0;
      const gap = nextFirstLine - lastLine - 1;
      if (gap > EXPAND_STEP) {
        const downKey = `${this.file.path}:${this.hunkIndex}:down`;
        const upKey = `${this.file.path}:${this.hunkIndex + 1}:up`;
        const loading = this.expandingHunks.has(downKey) || this.expandingHunks.has(upKey);
        return this.renderExpandButton(
          `Show ${EXPAND_STEP} of ${gap} hidden lines below`,
          () => this._fireExpand("down", this.hunkIndex),
          loading,
          "down",
        );
      }
      return nothing;
    }

    // Last hunk — show if there might be more lines below
    if (lastLine > 0) {
      const key = `${this.file.path}:${this.hunkIndex}:down`;
      const loading = this.expandingHunks.has(key);
      return this.renderExpandButton(
        `Show more lines below`,
        () => this._fireExpand("down", this.hunkIndex),
        loading,
        "down",
      );
    }
    return nothing;
  }

  // ---- Main render ----------------------------------------------------------

  override render() {
    const hunk = this.hunk;
    return html`
      ${this.renderSeparator()}
      <div class="bg-zinc-900/50 px-2 py-1 text-zinc-500 text-xs border-t border-zinc-700 font-mono">
        ${hunk.header}
      </div>
      ${hunk.lines.map((line, i) => this.renderLine(line, i))}
      ${this.renderTrailer()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-hunk": DiffHunk;
  }
}
