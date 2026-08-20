/**
 * Source Viewer — @pierre/diffs' standalone File renderer with worker-backed
 * Shiki highlighting, line selection, and the file browser's size safeguards.
 */

import { File as PierreFile, type FileContents, type FileOptions, type SelectedLineRange } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { PierreRenderer } from "../../controllers/pierre-renderer.js";
import { shouldWrapLines } from "../../models/changes/diff-utils.js";
import { getPierreWorkerPool, PIERRE_SHIKI_THEME } from "../../models/changes/pierre-worker-pool.js";

/** Max lines to render before truncating. */
export const MAX_SOURCE_RENDER_LINES = 5000;

/** Max file size (in characters) before syntax highlighting is disabled. */
export const LARGE_SOURCE_HIGHLIGHT_THRESHOLD = 200_000;

export function preparePierreSourceFile(path: string, content: string) {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const truncated = totalLines > MAX_SOURCE_RENDER_LINES;
  const renderedContents = truncated
    ? lines.slice(0, MAX_SOURCE_RENDER_LINES).join("\n")
    : content;

  const file = {
    name: path,
    contents: renderedContents,
    ...(content.length > LARGE_SOURCE_HIGHLIGHT_THRESHOLD ? { lang: "text" as const } : {}),
  } satisfies FileContents;

  return { file, totalLines, truncated };
}

const SOURCE_FILE_CSS = `
[data-selected-line] {
  background: rgb(234 179 8 / 0.15) !important;
  box-shadow: inset 2px 0 0 rgb(234 179 8) !important;
}
`;

@customElement("file-viewer-code")
export class FileViewerCode extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) content: string | null = null;
  @property() path = "";
  @property({ attribute: false }) highlightRange: { startLine: number; endLine: number } | null = null;

  private _pendingScrollToHighlight = false;
  private _selectionFromPierre = false;
  private readonly _renderer = new PierreRenderer<{
    path: string;
    content: string;
    file: FileContents;
  }, PierreFile>(this, {
    create: (_input, rendered) => new PierreFile({
      ...this._options(),
      onPostRender: () => rendered(),
    }, getPierreWorkerPool(), true),
    render: (renderer, input, container) => renderer.render({
      file: input.file,
      fileContainer: container,
    }),
    sameInput: (left, right) => left.path === right.path && left.content === right.content,
    onRendered: () => this._applyHighlightRange(),
  });

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("highlightRange") && this.highlightRange && !this._selectionFromPierre) {
      this._pendingScrollToHighlight = true;
    }
    this._selectionFromPierre = false;
  }

  override updated() {
    this._applyHighlightRange();
  }

  resetHighlight() {
    this.highlightRange = null;
    this._renderer.instance?.setSelectedLines(null);
  }

  private _options(): FileOptions<undefined> {
    return {
      theme: PIERRE_SHIKI_THEME,
      themeType: "dark",
      disableFileHeader: true,
      overflow: shouldWrapLines(this.path) ? "wrap" : "scroll",
      enableLineSelection: true,
      lineHoverHighlight: "both",
      tokenizeMaxLength: LARGE_SOURCE_HIGHLIGHT_THRESHOLD,
      unsafeCSS: SOURCE_FILE_CSS,
      onLineSelected: (range) => this._onPierreSelection(range),
      onLineClick: ({ lineNumber }) => {
        const range = this.highlightRange;
        if (range && (lineNumber < range.startLine || lineNumber > range.endLine)) {
          this._renderer.instance?.setSelectedLines(null);
        }
      },
    };
  }

  private _onPierreSelection(range: SelectedLineRange | null) {
    const nextRange = range ? { startLine: range.start, endLine: range.end } : null;
    if (
      nextRange?.startLine === this.highlightRange?.startLine &&
      nextRange?.endLine === this.highlightRange?.endLine
    ) return;
    this._selectionFromPierre = true;
    this.highlightRange = nextRange;
  }

  private _applyHighlightRange() {
    const renderer = this._renderer.instance;
    if (!renderer) return;
    const range = this.highlightRange;
    renderer.setSelectedLines(range ? { start: range.startLine, end: range.endLine } : null, {
      notify: false,
    });
    if (!range || !this._pendingScrollToHighlight) return;

    this._pendingScrollToHighlight = false;
    const root = this._renderer.container;
    const line = root?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${range.startLine}"]`)
      ?? root?.querySelector<HTMLElement>(`[data-line="${range.startLine}"]`);
    if (!line) return;
    requestAnimationFrame(() => {
      line.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }

  override render() {
    if (!this.content) return nothing;

    const prepared = preparePierreSourceFile(this.path, this.content);
    const binding = this._renderer.bind({ path: this.path, content: this.content, file: prepared.file });
    return html`
      <div class="font-mono text-xs leading-5 bg-zinc-950">
        <diffs-container data-pierre-file ${binding}></diffs-container>
        ${prepared.truncated
          ? html`<div class="px-4 py-3 text-center text-sm text-zinc-500 border-t border-zinc-700">
              Showing first ${MAX_SOURCE_RENDER_LINES.toLocaleString()} of ${prepared.totalLines.toLocaleString()} lines
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
