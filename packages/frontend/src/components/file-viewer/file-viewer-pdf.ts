/**
 * PDF Viewer — renders an inline PDF preview via `<iframe>`.
 *
 * Points an `<iframe>` at the backend content endpoint, which serves
 * the raw PDF bytes with the correct Content-Type. The browser's
 * built-in PDF viewer handles rendering.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("file-viewer-pdf")
export class FileViewerPdf extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** URL to the raw PDF content (backend endpoint). */
  @property() src = "";

  override render() {
    return html`
      <div class="flex-1 min-h-0 flex flex-col">
        <iframe
          src="${this.src}"
          class="flex-1 w-full border-0"
          title="PDF preview"
        ></iframe>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-pdf": FileViewerPdf;
  }
}
