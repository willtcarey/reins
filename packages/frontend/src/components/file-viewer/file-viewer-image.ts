/**
 * Image Viewer — renders inline image preview for image files.
 *
 * Points an `<img>` tag at the backend content endpoint. Shows a
 * checkerboard background so transparency is visible (especially
 * useful for SVGs and PNGs with alpha).
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("file-viewer-image")
export class FileViewerImage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** URL to the raw file content (backend endpoint). */
  @property() src = "";

  /** File name for the alt attribute. */
  @property() filename = "";

  override render() {
    return html`
      <div class="flex-1 overflow-auto min-h-0 flex items-center justify-center p-6 bg-zinc-900/50">
        <img
          src="${this.src}"
          alt="${this.filename}"
          class="max-w-full max-h-full object-contain"
          style="background: repeating-conic-gradient(#3f3f46 0% 25%, transparent 0% 50%) 50% / 16px 16px"
          loading="lazy"
        />
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-image": FileViewerImage;
  }
}
