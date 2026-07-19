/**
 * Source Viewer — @pierre/diffs' standalone File renderer with worker-backed
 * Shiki highlighting, line selection, and the file browser's size safeguards.
 */

import { File as PierreFile, type FileContents, type FileOptions, type SelectedLineRange } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
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

  private _file: PierreFile | null = null;
  private _fileRoot: HTMLElement | null = null;
  private _renderedPath: string | null = null;
  private _renderedContent: string | null = null;
  private _pendingScrollToHighlight = false;
  private _selectionFromPierre = false;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("highlightRange") && this.highlightRange && !this._selectionFromPierre) {
      this._pendingScrollToHighlight = true;
    }
    this._selectionFromPierre = false;
  }

  override updated() {
    this._syncPierreFile();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyPierreFile();
  }

  resetHighlight() {
    this.highlightRange = null;
    this._file?.setSelectedLines(null);
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
          this._file?.setSelectedLines(null);
        }
      },
      onPostRender: () => this._applyHighlightRange(),
    };
  }

  private _syncPierreFile() {
    const root = this.querySelector<HTMLElement>("[data-pierre-file]");
    if (!root || !this.content || !this.path) {
      this._destroyPierreFile();
      return;
    }

    if (
      this._file &&
      this._fileRoot === root &&
      this._renderedPath === this.path &&
      this._renderedContent === this.content
    ) {
      this._applyHighlightRange();
      return;
    }

    const prepared = preparePierreSourceFile(this.path, this.content);
    this._destroyPierreFile();
    this._file = new PierreFile(this._options(), getPierreWorkerPool(), true);
    this._fileRoot = root;
    this._renderedPath = this.path;
    this._renderedContent = this.content;
    this._file.render({ file: prepared.file, fileContainer: root });
    this._applyHighlightRange();
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
    if (!this._file) return;
    const range = this.highlightRange;
    this._file.setSelectedLines(range ? { start: range.startLine, end: range.endLine } : null, {
      notify: false,
    });
    if (!range || !this._pendingScrollToHighlight) return;

    this._pendingScrollToHighlight = false;
    const root = this._fileRoot;
    const line = root?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${range.startLine}"]`)
      ?? root?.querySelector<HTMLElement>(`[data-line="${range.startLine}"]`);
    if (!line) return;
    requestAnimationFrame(() => {
      line.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }

  private _destroyPierreFile() {
    this._file?.cleanUp();
    this._file = null;
    this._fileRoot = null;
    this._renderedPath = null;
    this._renderedContent = null;
  }

  override render() {
    if (!this.content) return nothing;

    const prepared = preparePierreSourceFile(this.path, this.content);
    return html`
      <div class="font-mono text-xs leading-5 bg-zinc-950">
        <diffs-container data-pierre-file></diffs-container>
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
