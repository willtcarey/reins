/**
 * File Viewer — syntax-highlighted, read-only file content viewer.
 *
 * Renders the content of a single file with line numbers and Shiki
 * syntax highlighting via the shared highlight worker. Handles loading
 * states, errors, binary files, and large file truncation.
 *
 * Fires:
 *   `close` — when the user clicks the close (✕) button or presses Escape
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { FileBrowserStore } from "../models/stores/file-browser-store.js";
import { shouldWrapLines } from "../models/changes/diff-utils.js";
import { getSharedHighlighter } from "../models/changes/shared-highlighter.js";
import type { IHighlighter } from "../models/changes/highlighter.js";

/** Max lines to render before truncating. */
const MAX_RENDER_LINES = 5000;

/** Max file size (in characters) before we skip highlighting. */
const LARGE_FILE_THRESHOLD = 200_000;

@customElement("file-viewer")
export class FileViewer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _storeVersion = 0;
  @state() private _highlightedLines: string[] | null = null;

  private _unsub: (() => void) | null = null;
  private _highlighter: IHighlighter | null = null;
  /** Track which file we last requested highlighting for. */
  private _highlightedPath: string | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribeToStore();
    // Highlight immediately if content is already loaded
    this._maybeHighlight();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._subscribeToStore();
    }
  }

  private _subscribeToStore() {
    this._unsub?.();
    if (!this.store) return;
    this._unsub = this.store.subscribe(() => {
      this._storeVersion++;
      this._maybeHighlight();
    });
  }

  private _maybeHighlight() {
    if (!this.store) return;
    const { fileContent, selectedFile, isBinary, contentError } = this.store;
    if (!fileContent || !selectedFile || isBinary || contentError) return;

    // Don't re-highlight the same file
    if (selectedFile === this._highlightedPath && this._highlightedLines) return;

    if (fileContent.length > LARGE_FILE_THRESHOLD) {
      this._highlightedLines = null;
      this._highlightedPath = selectedFile;
      return;
    }

    if (!this._highlighter) {
      this._highlighter = getSharedHighlighter();
    }

    const path = selectedFile;
    const lines = fileContent.split("\n");
    this._highlightedPath = path;
    this._highlightedLines = null;

    this._highlighter.highlightHunk(path, lines, (htmlLines) => {
      if (this.store?.selectedFile === path) {
        this._highlightedLines = htmlLines;
        this.requestUpdate();
      }
    });
  }

  /** Clear highlight cache. Call when the viewer is hidden/reused. */
  resetHighlight() {
    this._highlightedLines = null;
    this._highlightedPath = null;
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    void this._storeVersion;
    const store = this.store;
    if (!store) return nothing;
    const path = store.selectedFile;

    return html`
      <div class="w-[90vw] h-[90vh] bg-zinc-800 ring-1 ring-zinc-600 rounded-lg shadow-2xl flex flex-col">
        <!-- Header -->
        <div class="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 min-w-0">
          <span class="text-sm text-zinc-300 font-mono truncate flex-1">${path}</span>
          <kbd class="hidden sm:inline text-[10px] text-zinc-500 bg-zinc-700 px-1.5 py-0.5 rounded">Esc</kbd>
          <button
            class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
            @click=${() =>
              this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }))}
            title="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-auto min-h-0">
          ${store.contentLoading
            ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">Loading...</div>`
            : store.contentError
              ? html`<div class="px-4 py-8 text-center text-sm text-red-400">${store.contentError}</div>`
              : store.isBinary
                ? html`<div class="px-4 py-8 text-center text-sm text-zinc-500">${store.fileContent}</div>`
                : this.renderFileContent()}
        </div>
      </div>
    `;
  }

  private renderFileContent() {
    const content = this.store.fileContent;
    if (!content) return nothing;

    const lines = content.split("\n");
    const totalLines = lines.length;
    const truncated = totalLines > MAX_RENDER_LINES;
    const displayLines = truncated ? lines.slice(0, MAX_RENDER_LINES) : lines;
    const highlighted = this._highlightedLines;
    const gutterWidth = String(truncated ? MAX_RENDER_LINES : totalLines).length;
    const wrap = shouldWrapLines(this.store.selectedFile ?? "");
    const contentCls = wrap ? "pl-4 pr-3 py-0 whitespace-pre-wrap break-words" : "pl-4 pr-3 py-0 whitespace-pre";

    return html`
      <div class="font-mono text-xs leading-5">
        <table class="${wrap ? "w-full table-fixed" : "w-fit min-w-full"} border-collapse">
          <tbody>
            ${displayLines.map((line, i) => {
              const lineHtml = highlighted?.[i];
              return html`
                <tr class="hover:bg-zinc-700/30">
                  <td class="text-right text-zinc-600 select-none px-2 py-0 align-top whitespace-nowrap border-r border-zinc-700/50"
                      style="${wrap ? `width: ${gutterWidth + 2}ch` : `min-width: ${gutterWidth + 1}ch`}">${i + 1}</td>
                  <td class="${contentCls}">${lineHtml ? unsafeHTML(lineHtml) : line}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
        ${truncated
          ? html`<div class="px-4 py-3 text-center text-sm text-zinc-500 border-t border-zinc-700">
              Showing first ${MAX_RENDER_LINES.toLocaleString()} of ${totalLines.toLocaleString()} lines
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer": FileViewer;
  }
}
