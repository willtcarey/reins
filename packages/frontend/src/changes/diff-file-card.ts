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
 *  - `toggle-rendered`  (detail: string — the file path)
 *  - `fetch-markdown`   (detail: string — the file path)
 *
 * The parent (`<diff-panel>`) wires these to the DiffStore and manages
 * markdown caching state.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { DiffFile } from "./types.js";
import { isMarkdown, fileCardId, gutterWidth } from "./diff-utils.js";
import "./diff-hunk.js";
import "./diff-markdown-preview.js";

@customElement("diff-file-card")
export class DiffFileCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  file!: DiffFile;

  /** Whether this file card is collapsed. */
  @property({ type: Boolean })
  collapsed = false;

  /** Whether this markdown file is in rendered/preview mode. */
  @property({ type: Boolean })
  rendered = false;

  /** Whether markdown content is currently loading. */
  @property({ type: Boolean, attribute: "markdown-loading" })
  markdownLoading = false;

  /** Rendered markdown HTML content. */
  @property({ attribute: false })
  markdownContent: string | null = null;

  /** Set of expanding-hunk keys currently loading. */
  @property({ attribute: false })
  expandingHunks: Set<string> = new Set();


  /** URL builder for file downloads. */
  @property({ attribute: false })
  fileUrl: ((path: string) => string | null) | null = null;

  // ---- Internal state -------------------------------------------------------

  /** Whether the path was just copied to clipboard. */
  @state() private copied = false;
  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._copyTimer) clearTimeout(this._copyTimer);
  }

  // ---- Actions --------------------------------------------------------------

  private _toggleCollapse() {
    this.dispatchEvent(new CustomEvent<string>("toggle-collapse", {
      bubbles: true,
      composed: true,
      detail: this.file.path,
    }));
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
    const url = this.fileUrl?.(this.file.path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url + "&download=1";
    a.download = this.file.path.split("/").pop() || this.file.path;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  private _onToggleRendered() {
    this.dispatchEvent(new CustomEvent<string>("toggle-rendered", {
      bubbles: true,
      composed: true,
      detail: this.file.path,
    }));
  }

  // ---- Render ---------------------------------------------------------------

  private renderDiffContent() {
    const wrap = isMarkdown(this.file.path);
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
          class="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-750 text-sm cursor-pointer sticky top-0 z-10 rounded-t-lg border-b border-zinc-700"
          @click=${() => this._toggleCollapse()}
        >
          <span class="text-zinc-500 font-mono text-xs shrink-0">${this.collapsed ? "▶" : "▼"}</span>
          <span class="font-mono text-zinc-200 flex-1 min-w-0 text-left truncate direction-rtl text-ellipsis" title=${file.path}>${file.path}</span>
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
              .content=${this.markdownContent}
              @toggle-rendered=${() => this._onToggleRendered()}
            ></diff-markdown-preview>
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
