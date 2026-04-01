/**
 * Diff File Card
 *
 * Lit component that renders a single file's diff card: collapsible header
 * with file path, copy/download actions, optional markdown badge/toggle,
 * diff hunks, and markdown preview.
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
import { openInBrowserEvent } from "../events.js";
import { isMarkdown, shouldWrapLines, fileCardId, gutterWidth } from "../../models/changes/diff-utils.js";
import "./diff-hunk.js";
import "./diff-markdown-preview.js";

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

  /** Whether the path was just copied to clipboard. */
  @state() private copied = false;
  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._copyTimer) clearTimeout(this._copyTimer);
  }

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

  private async _copyPath(e: Event) {
    e.stopPropagation();
    const path = this.file.path;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(path);
      } else {
        this._copyFallback(path);
      }
      this._showCopied();
    } catch {
      try {
        this._copyFallback(path);
        this._showCopied();
      } catch (err) {
        console.error("Failed to copy path to clipboard:", err);
      }
    }
  }

  private _copyFallback(text: string) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  private _showCopied() {
    this.copied = true;
    if (this._copyTimer) clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => { this.copied = false; }, 1500);
  }

  private _downloadFile(e: Event) {
    e.stopPropagation();
    const url = this._fileUrl();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url + "&download=1";
    a.download = this.file.path.split("/").pop() || this.file.path;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** Open this file in the file browser overlay. */
  private _openInBrowser(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(openInBrowserEvent(this.file.path));
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

    return html`
      <div class="mx-4 mb-3 first:mt-4 border border-zinc-700 rounded-lg" id=${fileCardId(file.path)} data-file-path=${file.path}>
        <button
          class="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-750 text-sm cursor-pointer sticky top-0 z-[var(--layer-content)] rounded-t-lg border-b border-zinc-700"
          @click=${() => this._toggleCollapse()}
        >
          <span class="text-zinc-500 font-mono text-xs shrink-0">${this.collapsed ? "▶" : "▼"}</span>
          <span class="font-mono text-zinc-200 flex-1 min-w-0 text-left truncate direction-rtl text-ellipsis" title=${file.path}>${file.path}</span>
          <span
            class="inline-flex items-center text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 rounded hover:bg-zinc-700/50 shrink-0"
            title="View file"
            @click=${(e: Event) => this._openInBrowser(e)}
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
          </span>
          <span
            class="inline-flex items-center text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 rounded hover:bg-zinc-700/50 shrink-0"
            title="Copy path"
            @click=${(e: Event) => this._copyPath(e)}
          >
            ${this.copied
              ? html`<svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
              : html`<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`
            }
          </span>
          <span
            class="inline-flex items-center text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 rounded hover:bg-zinc-700/50 shrink-0"
            title="Download file"
            @click=${(e: Event) => this._downloadFile(e)}
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
          </span>
          ${isMd ? html`<span class="text-blue-400 text-xs font-mono px-1.5 py-0.5 bg-blue-400/10 rounded shrink-0">MD</span>` : nothing}
          ${file.additions > 0 ? html`<span class="text-green-400 text-xs font-mono shrink-0">+${file.additions}</span>` : nothing}
          ${file.removals > 0 ? html`<span class="text-red-400 text-xs font-mono shrink-0">-${file.removals}</span>` : nothing}
        </button>
        ${!this.collapsed ? html`
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
          ${!(isMd && this.rendered) ? this.renderDiffContent() : nothing}
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
