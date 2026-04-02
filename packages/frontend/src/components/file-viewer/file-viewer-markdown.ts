/**
 * Markdown Viewer — renders markdown with a code/preview toggle.
 *
 * Shows a tab bar with "Code" (syntax-highlighted source) and "Preview"
 * (rendered markdown via `<markdown-content>`). Dispatches a custom event
 * when the user toggles modes so the parent can track state if needed.
 */

import { LitElement, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../markdown-content.js";
import "../view-mode-tabs.js";
import type { TabDef } from "../view-mode-tabs.js";

const CODE_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>`;
const PREVIEW_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>`;

const TABS: TabDef[] = [
  {
    label: "Code",
    icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${CODE_ICON}</svg>`,
  },
  {
    label: "Preview",
    icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${PREVIEW_ICON}</svg>`,
  },
];

@customElement("file-viewer-markdown")
export class FileViewerMarkdown extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Raw markdown text. */
  @property({ attribute: false }) content: string | null = null;

  /** Whether to show rendered preview (true) or code view (false). */
  @state() private _preview = false;

  /** Reset to code view (e.g. when switching files). */
  resetPreview() {
    this._preview = false;
  }

  private _onTabChange(e: CustomEvent<number>) {
    this._preview = e.detail === 1;
  }

  override render() {
    if (!this.content) return nothing;

    return html`
      <div class="flex-1 overflow-hidden min-h-0 flex flex-col">
        <!-- Tab bar -->
        <view-mode-tabs
          class="shrink-0"
          .tabs=${TABS}
          .activeIndex=${this._preview ? 1 : 0}
          @tab-change=${this._onTabChange}
        ></view-mode-tabs>

        ${this._preview
          ? html`<div class="flex-1 overflow-auto p-5">
              <markdown-content .text=${this.content}></markdown-content>
            </div>`
          : html`<slot></slot>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-markdown": FileViewerMarkdown;
  }
}
