/**
 * Markdown Viewer — renders a markdown preview.
 *
 * A file is text from outside (a cloned repository's README), so it is drawn by `<reins-markdown>`: the chat's
 * look, without raw HTML, which would run in the app's page.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../reins-markdown.js";

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
          <reins-markdown .text=${this.content}></reins-markdown>
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
