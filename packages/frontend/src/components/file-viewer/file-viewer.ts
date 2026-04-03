/**
 * File Viewer — dispatches to type-specific renderers based on file extension.
 *
 * Rendering strategy:
 *  - **Text files** always get a code view. If a preview renderer exists for
 *    the file type, Code + Preview tabs are shown.
 *  - **Binary files** show `<file-viewer-binary>` unless a preview renderer
 *    exists for the file type (image, PDF), in which case that renders directly.
 *
 * This component only renders the content area — the header bar and
 * outer container are owned by `<file-browser>`.
 */

import { LitElement, html, nothing, svg } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { TemplateResult } from "lit";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import { StoreController } from "../../controllers/store-controller.js";
import { isMarkdown, isImage, isPdf } from "../../models/changes/diff-utils.js";
import "./file-viewer-image.js";
import "./file-viewer-pdf.js";
import "./file-viewer-binary.js";
import "./file-viewer-markdown.js";
import "./file-viewer-code.js";
import "../view-mode-tabs.js";
import type { TabDef } from "../view-mode-tabs.js";
import type { FileViewerCode } from "./file-viewer-code.js";

type ViewMode = "code" | "preview";

const CODE_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>`;
const PREVIEW_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>`;

const CODE_PREVIEW_TABS: TabDef[] = [
  {
    label: "Code",
    icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${CODE_ICON}</svg>`,
  },
  {
    label: "Preview",
    icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${PREVIEW_ICON}</svg>`,
  },
];

@customElement("file-viewer")
export class FileViewer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  @state() private _viewMode: ViewMode = "code";

  /** Track the file the view mode applies to so we reset on file change. */
  private _viewModeFile: string | null = null;

  private _storeCtrl = new StoreController(this);

  @query("file-viewer-code") private _codeViewer?: FileViewerCode;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._storeCtrl.store = this.store;
    }

    // Reset view mode when the selected file changes.
    const path = this.store?.selectedFile ?? null;
    if (path !== this._viewModeFile) {
      this._viewModeFile = path;
      this._viewMode = "code";
    }
  }

  /** Set a line range to highlight and scroll to in the code viewer. */
  setHighlightRange(range: { startLine: number; endLine: number }) {
    if (this._viewMode !== "code") {
      this._viewMode = "code";
    }
    this.updateComplete.then(() => {
      if (this._codeViewer) {
        this._codeViewer.highlightRange = range;
      }
    });
  }

  /** Clear cached state in child renderers. */
  resetHighlight() {
    this._codeViewer?.resetHighlight();
  }

  // ---- Preview renderers ----------------------------------------------------

  /** Whether a preview renderer exists for this file type. */
  private _hasPreviewRenderer(path: string | null): boolean {
    if (!path) return false;
    return isImage(path) || isPdf(path) || isMarkdown(path);
  }

  /** Render the preview for the current file, or nothing. */
  private _renderPreview(path: string, store: FileBrowserStore): TemplateResult | typeof nothing {
    if (isImage(path) && store.contentUrl) {
      const filename = path.split("/").pop() ?? path;
      return html`<file-viewer-image
        class="flex-1 min-h-0 flex flex-col"
        src=${store.contentUrl}
        filename=${filename}
      ></file-viewer-image>`;
    }

    if (isPdf(path) && store.contentUrl) {
      return html`<file-viewer-pdf
        class="flex-1 min-h-0 flex flex-col"
        src=${store.contentUrl}
      ></file-viewer-pdf>`;
    }

    if (isMarkdown(path) && store.fileContent) {
      return html`<file-viewer-markdown
        class="flex-1 min-h-0 flex flex-col"
        .content=${store.fileContent}
      ></file-viewer-markdown>`;
    }

    return nothing;
  }

  // ---- Tabs -----------------------------------------------------------------

  private _onTabChange(e: CustomEvent<number>) {
    this._viewMode = e.detail === 0 ? "code" : "preview";
  }

  private _renderTabs() {
    return html`<view-mode-tabs
      class="shrink-0"
      .tabs=${CODE_PREVIEW_TABS}
      .activeIndex=${this._viewMode === "code" ? 0 : 1}
      @tab-change=${this._onTabChange}
    ></view-mode-tabs>`;
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

    const hasPreview = this._hasPreviewRenderer(path);

    // ── Binary ──
    if (store.isBinary) {
      if (hasPreview) return this._renderPreview(path, store);
      return html`<file-viewer-binary
        class="flex-1 min-h-0 flex flex-col"
        label=${store.fileContent ?? "Binary file"}
      ></file-viewer-binary>`;
    }

    // ── Text with preview → code + preview tabs ──
    if (hasPreview) {
      return html`
        <div class="flex-1 overflow-hidden min-h-0 flex flex-col">
          ${this._renderTabs()}
          ${this._viewMode === "preview"
            ? this._renderPreview(path, store)
            : html`<file-viewer-code
                class="flex-1 overflow-auto min-h-0"
                .content=${store.fileContent}
                .path=${path}
              ></file-viewer-code>`}
        </div>
      `;
    }

    // ── Text, no preview → code only ──
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
