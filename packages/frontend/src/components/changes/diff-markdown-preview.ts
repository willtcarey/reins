/**
 * Diff Markdown Preview
 *
 * Lit component that renders the markdown view-toggle tabs (Diff / Preview)
 * and the rendered markdown content for a file. Used inside `<diff-file-card>`.
 *
 * Events emitted:
 *  - `toggle-rendered` (no detail) — user clicked to switch modes
 */

import { LitElement, html, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../markdown-content.js";
import "../view-mode-tabs.js";
import type { TabDef } from "../view-mode-tabs.js";

const CODE_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>`;
const PREVIEW_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>`;

const TABS: TabDef[] = [
  {
    label: "Diff",
    icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${CODE_ICON}</svg>`,
  },
  {
    label: "Preview",
    icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${PREVIEW_ICON}</svg>`,
  },
];

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

  private _onTabChange(e: CustomEvent<number>) {
    const wantsPreview = e.detail === 1;
    if (wantsPreview !== this.rendered) this._fireToggle();
  }

  /** Render the Diff / Preview tab bar. */
  renderViewToggle() {
    return html`
      <view-mode-tabs
        .tabs=${TABS}
        .activeIndex=${this.rendered ? 1 : 0}
        @tab-change=${this._onTabChange}
      ></view-mode-tabs>
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
