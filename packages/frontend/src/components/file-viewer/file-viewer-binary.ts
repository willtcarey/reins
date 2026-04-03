/**
 * Binary Viewer — placeholder for binary files without a dedicated renderer.
 *
 * Shows file size info and a message indicating the file can't be previewed.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("file-viewer-binary")
export class FileViewerBinary extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Description of the binary file (e.g. "Binary file (12 KB)"). */
  @property() label = "Binary file";

  override render() {
    return html`
      <div class="flex-1 overflow-auto min-h-0 flex items-center justify-center p-6">
        <div class="text-center text-sm text-zinc-500">${this.label}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-binary": FileViewerBinary;
  }
}
