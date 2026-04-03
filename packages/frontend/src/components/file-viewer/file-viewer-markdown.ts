/**
 * Markdown Viewer — renders a markdown preview.
 *
 * Renders markdown content via `<markdown-content>`.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../markdown-content.js";

@customElement("file-viewer-markdown")
export class FileViewerMarkdown extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Raw markdown text. */
  @property({ attribute: false }) content: string | null = null;

  override render() {
    if (!this.content) return nothing;

    return html`
      <div class="flex-1 overflow-hidden min-h-0 flex flex-col">
        <div class="flex-1 overflow-auto p-5">
          <markdown-content .text=${this.content}></markdown-content>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-markdown": FileViewerMarkdown;
  }
}
