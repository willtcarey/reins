/**
 * Diff Markdown Preview
 *
 * Lit component that renders the markdown view-toggle tabs (Diff / Preview)
 * and the rendered markdown content for a file. Used inside `<diff-file-card>`.
 *
 * Events emitted:
 *  - `toggle-rendered` (no detail) — user clicked to switch modes
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../markdown-content.js";

@customElement("diff-markdown-preview")
export class DiffMarkdownPreview extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Whether the file is currently in rendered (preview) mode. */
  @property({ type: Boolean })
  rendered = false;

  /** Whether the markdown content is currently loading. */
  @property({ type: Boolean })
  loading = false;

  /** The raw markdown text to preview. */
  @property({ attribute: false })
  content: string | null = null;



  private _fireToggle() {
    this.dispatchEvent(new Event("toggle-rendered", { bubbles: true, composed: true }));
  }

  /** Render the Diff / Preview tab bar. */
  renderViewToggle() {
    return html`
      <div class="flex items-center border-b border-zinc-700 bg-zinc-800/50" @click=${(e: Event) => e.stopPropagation()}>
        <button
          class="px-3 py-1.5 text-xs cursor-pointer transition-colors ${
            !this.rendered
              ? "text-zinc-200 border-b-2 border-blue-400"
              : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent"
          }"
          @click=${() => { if (this.rendered) this._fireToggle(); }}
        >
          <span class="flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
            </svg>
            Diff
          </span>
        </button>
        <button
          class="px-3 py-1.5 text-xs cursor-pointer transition-colors ${
            this.rendered
              ? "text-zinc-200 border-b-2 border-blue-400"
              : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent"
          }"
          @click=${() => { if (!this.rendered) this._fireToggle(); }}
        >
          <span class="flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            Preview
          </span>
        </button>
      </div>
    `;
  }

  /** Render the markdown preview content area. */
  renderPreview() {
    // Only show spinner on initial load, not background refreshes
    if (this.loading && !this.content) {
      return html`
        <div class="p-4 text-zinc-500 text-sm flex items-center gap-2">
          <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Loading preview…
        </div>
      `;
    }

    if (this.content) {
      return html`
        <div class="p-5">
          <markdown-content .text=${this.content}></markdown-content>
        </div>
      `;
    }

    return html`
      <div class="p-4 text-zinc-500 text-sm">No content available</div>
    `;
  }

  override render() {
    return html`
      ${this.renderViewToggle()}
      ${this.rendered ? this.renderPreview() : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-markdown-preview": DiffMarkdownPreview;
  }
}
