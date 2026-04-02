/**
 * File Viewer — dispatches to type-specific renderers based on file extension.
 *
 * Renderers:
 *  - `<file-viewer-image>` — inline image preview (.png, .jpg, .svg, etc.)
 *  - `<file-viewer-pdf>`   — inline PDF embed
 *  - `<file-viewer-markdown>` — code/preview toggle for markdown files
 *  - `<file-viewer-code>`  — syntax-highlighted code with line numbers (default)
 *
 * This component only renders the content area — the header bar and
 * outer container are owned by `<file-browser>`.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import { StoreController } from "../../controllers/store-controller.js";
import { isMarkdown, isImage, isPdf } from "../../models/changes/diff-utils.js";
import "./file-viewer-image.js";
import "./file-viewer-pdf.js";
import "./file-viewer-markdown.js";
import "./file-viewer-code.js";
import type { FileViewerCode } from "./file-viewer-code.js";
import type { FileViewerMarkdown } from "./file-viewer-markdown.js";

@customElement("file-viewer")
export class FileViewer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  private _storeCtrl = new StoreController(this);

  @query("file-viewer-code") private _codeViewer?: FileViewerCode;
  @query("file-viewer-markdown") private _markdownViewer?: FileViewerMarkdown;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._storeCtrl.store = this.store;
    }
  }

  /** Clear cached state in child renderers. Call when the viewer is hidden/reused. */
  resetHighlight() {
    this._codeViewer?.resetHighlight();
    this._markdownViewer?.resetPreview();
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    const store = this.store;
    if (!store) return nothing;

    if (store.contentLoading) {
      return html`<div class="flex-1 overflow-auto min-h-0">
        <div class="px-4 py-8 text-center text-sm text-zinc-500">Loading...</div>
      </div>`;
    }

    if (store.contentError) {
      return html`<div class="flex-1 overflow-auto min-h-0">
        <div class="px-4 py-8 text-center text-sm text-red-400">${store.contentError}</div>
      </div>`;
    }

    const path = store.selectedFile;
    if (!path) return nothing;

    // Image preview
    if (isImage(path) && store.contentUrl) {
      const filename = path.split("/").pop() ?? path;
      return html`<file-viewer-image
        class="flex-1 min-h-0 flex flex-col"
        src=${store.contentUrl}
        filename=${filename}
      ></file-viewer-image>`;
    }

    // PDF preview
    if (isPdf(path) && store.contentUrl) {
      return html`<file-viewer-pdf
        class="flex-1 min-h-0 flex flex-col"
        src=${store.contentUrl}
      ></file-viewer-pdf>`;
    }

    // Markdown: code/preview toggle wrapping the code viewer
    if (isMarkdown(path) && store.fileContent && !store.isBinary) {
      return html`<file-viewer-markdown
        class="flex-1 min-h-0 flex flex-col"
        .content=${store.fileContent}
      >
        <file-viewer-code
          class="flex-1 overflow-auto min-h-0"
          .content=${store.fileContent}
          .path=${path}
        ></file-viewer-code>
      </file-viewer-markdown>`;
    }

    // Other binary files
    if (store.isBinary) {
      return html`<div class="flex-1 overflow-auto min-h-0">
        <div class="px-4 py-8 text-center text-sm text-zinc-500">${store.fileContent}</div>
      </div>`;
    }

    // Default: syntax-highlighted code
    return html`<file-viewer-code
      class="flex-1 overflow-auto min-h-0"
      .content=${store.fileContent}
      .path=${path}
    ></file-viewer-code>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer": FileViewer;
  }
}
