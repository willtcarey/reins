/**
 * Diff File Card
 *
 * Lit component that renders a single file's diff card: collapsible header
 * with file path, copy/download actions, optional markdown badge/toggle,
 * diff hunks, markdown preview, and inline image/PDF previews for binary files.
 *
 * Events emitted:
 *  - `expand-up`        (detail: { filePath, hunkIndex })
 *  - `expand-down`      (detail: { filePath, hunkIndex })
 *
 * Collapse and markdown preview state are internal — each card manages its
 * own expanded/collapsed toggle and markdown fetch/cache/render cycle.
 * The parent (`<diff-panel>`) wires expand events to the DiffStore.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { DiffFile } from "../../models/changes/types.js";
import { isMarkdown, isImage, isPdf, shouldWrapLines, fileCardId, gutterWidth } from "../../models/changes/diff-utils.js";
import "./diff-file-action-buttons.js";
import "./diff-hunk.js";
import "./diff-markdown-preview.js";
import "../file-viewer/file-viewer-image.js";
import "../file-viewer/file-viewer-pdf.js";

@customElement("diff-file-card")
export class DiffFileCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  file!: DiffFile;

  /** Whether this file card is collapsed (internal toggle state). */
  @state() private collapsed = false;

  /** Whether this markdown file is in rendered/preview mode. */
  @state() private rendered = false;

  /** Whether markdown content is currently loading. */
  @state() private markdownLoading = false;

  /** Cached raw markdown text. */
  @state() private markdownContent: string | null = null;

  /** Error message from a failed markdown fetch. */
  @state() private markdownError: string | null = null;

  /** Track the file path the cached markdown belongs to, for invalidation. */
  private _cachedFilePath: string | null = null;

  /** Set of expanding-hunk keys currently loading. */
  @property({ attribute: false })
  expandingHunks: Set<string> = new Set();


  /** Project ID for file URL generation. */
  @property({ type: Number, attribute: false })
  projectId: number | null = null;

  /** Branch ref for file URL generation. */
  @property({ attribute: false })
  branch: string | null = null;

  // ---- Internal state -------------------------------------------------------

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("file") && this.file) {
      const prevPath = this._cachedFilePath;
      this._cachedFilePath = this.file.path;

      // Skip first assignment (no cached content to invalidate)
      if (prevPath === null) return;

      if (prevPath === this.file.path) {
        // Same file, new diff — clear cache and re-fetch if in preview mode
        this.markdownContent = null;
        this.markdownError = null;
        if (this.rendered) {
          this._fetchMarkdown();
        }
      } else {
        // Different file entirely (component reused) — reset everything
        this.markdownContent = null;
        this.markdownError = null;
        this.rendered = false;
      }
    }
  }

  // ---- URL helpers ----------------------------------------------------------

  /** Build the API URL for this file's raw content. */
  private _fileUrl(): string | null {
    if (this.projectId == null) return null;
    let url = `/api/projects/${this.projectId}/files/content?path=${encodeURIComponent(this.file.path)}`;
    if (this.branch) url += `&ref=${encodeURIComponent(this.branch)}`;
    return url;
  }

  // ---- Actions --------------------------------------------------------------

  private _toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  private async _toggleRendered() {
    if (this.rendered) {
      this.rendered = false;
      return;
    }

    this.rendered = true;

    if (!this.markdownContent) {
      await this._fetchMarkdown();
    }
  }

  /** Fetch the raw file content and render it as HTML via marked. */
  private async _fetchMarkdown() {
    const url = this._fileUrl();
    if (!url) return;

    this.markdownLoading = true;
    this.markdownError = null;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        this.markdownError = `Failed to load file (HTTP ${resp.status})`;
        return;
      }
      this.markdownContent = await resp.text();
    } catch (err: any) {
      this.markdownError = err.message;
    } finally {
      this.markdownLoading = false;
    }
  }

  // ---- Render ---------------------------------------------------------------

  /** Render an inline image preview for image files in the diff. */
  private renderImagePreview() {
    const url = this._fileUrl();
    if (!url) return nothing;
    const filename = this.file.path.split("/").pop() ?? this.file.path;
    return html`<file-viewer-image
      class="block"
      src=${url}
      filename=${filename}
    ></file-viewer-image>`;
  }

  /** Render an inline PDF preview for PDF files in the diff. */
  private renderPdfPreview() {
    const url = this._fileUrl();
    if (!url) return nothing;
    return html`<file-viewer-pdf
      class="block min-h-[400px]"
      src=${url}
    ></file-viewer-pdf>`;
  }

  private renderDiffContent() {
    const wrap = shouldWrapLines(this.file.path);
    const gw = gutterWidth(this.file);
    return html`
      <div class="text-xs overflow-x-auto">
        <div class="min-w-full ${wrap ? "" : "w-fit"}">
          ${this.file.hunks.map((_hunk, i) => html`
            <diff-hunk
              .file=${this.file}
              .hunkIndex=${i}
              .gutterCh=${gw}
              ?wrap=${wrap}
              .expandingHunks=${this.expandingHunks}
            ></diff-hunk>
          `)}
        </div>
      </div>
    `;
  }

  override render() {
    const file = this.file;
    const isMd = isMarkdown(file.path);
    const isImg = isImage(file.path);
    const isPdfFile = isPdf(file.path);

    return html`
      <div class="mx-4 mb-3 first:mt-4 border border-zinc-700 rounded-lg" id=${fileCardId(file.path)} data-file-path=${file.path}>
        <button
          class="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-750 text-sm cursor-pointer sticky top-0 z-[var(--layer-content)] rounded-t-lg border-b border-zinc-700"
          @click=${() => this._toggleCollapse()}
        >
          <span class="text-zinc-500 font-mono text-xs shrink-0">${this.collapsed ? "▶" : "▼"}</span>
          <span class="font-mono text-zinc-200 flex-1 min-w-0 text-left truncate direction-rtl text-ellipsis" title=${file.path}>${file.path}</span>
          <diff-view-file-button .path=${file.path}></diff-view-file-button>
          <diff-copy-path-button .path=${file.path}></diff-copy-path-button>
          <diff-download-file-button .path=${file.path} .href=${this._fileUrl() ?? ""}></diff-download-file-button>
          ${isMd ? html`<span class="text-blue-400 text-xs font-mono px-1.5 py-0.5 bg-blue-400/10 rounded shrink-0">MD</span>` : nothing}
          ${isImg ? html`<span class="text-purple-400 text-xs font-mono px-1.5 py-0.5 bg-purple-400/10 rounded shrink-0">IMG</span>` : nothing}
          ${isPdfFile ? html`<span class="text-orange-400 text-xs font-mono px-1.5 py-0.5 bg-orange-400/10 rounded shrink-0">PDF</span>` : nothing}
          ${file.additions > 0 ? html`<span class="text-green-400 text-xs font-mono shrink-0">+${file.additions}</span>` : nothing}
          ${file.removals > 0 ? html`<span class="text-red-400 text-xs font-mono shrink-0">-${file.removals}</span>` : nothing}
        </button>
        ${!this.collapsed ? html`
          ${isImg ? this.renderImagePreview() : nothing}
          ${isPdfFile ? this.renderPdfPreview() : nothing}
          ${isMd ? html`
            <diff-markdown-preview
              ?rendered=${this.rendered}
              ?loading=${this.markdownLoading}
              .content=${this.markdownError ? null : this.markdownContent}
              @toggle-rendered=${() => this._toggleRendered()}
            ></diff-markdown-preview>
            ${this.rendered && this.markdownError ? html`
              <div class="p-4 text-red-400 text-sm">${this.markdownError}</div>
            ` : nothing}
          ` : nothing}
          ${!(isMd && this.rendered) && !isImg && !isPdfFile ? this.renderDiffContent() : nothing}
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-file-card": DiffFileCard;
  }
}
