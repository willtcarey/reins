/**
 * File Viewer — dispatches to type-specific renderers based on file extension.
 *
 * Rendering strategy:
 *  1. Collect all applicable renderers into an array (each with a label, icon,
 *     and render function).
 *  2. If there are multiple renderers, show a tab bar to switch between them.
 *  3. If there's only one renderer, render it directly — no tab bar.
 *
 * This component only renders the content area — the header bar and
 * outer container are owned by `<file-browser>`.
 */

import { LitElement, html, nothing, svg } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { TemplateResult } from "lit";
import type { FileBrowserStore } from "../../models/stores/file-browser-store.js";
import { StoreController } from "../../controllers/store-controller.js";
import { isMarkdown, isImage, isPdf, isHtml } from "../../models/changes/diff-utils.js";
import type { FileViewMode } from "../events.js";
import "./file-viewer-image.js";
import "./file-viewer-pdf.js";
import "./file-viewer-binary.js";
import "./file-viewer-markdown.js";
import "./file-viewer-html.js";
import "./file-viewer-code.js";
import "../view-mode-tabs.js";
import type { TabDef } from "../view-mode-tabs.js";
import type { FileViewerCode } from "./file-viewer-code.js";

interface RendererDef {
  tab: TabDef;
  render: () => TemplateResult;
}

const CODE_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>`;
const PREVIEW_ICON = svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>`;

const CODE_TAB: TabDef = {
  label: "Code",
  icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${CODE_ICON}</svg>`,
};

const PREVIEW_TAB: TabDef = {
  label: "Preview",
  icon: html`<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">${PREVIEW_ICON}</svg>`,
};

@customElement("file-viewer")
export class FileViewer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: FileBrowserStore;

  /** Initial tab to show when opening/selecting a file. */
  @property() initialView: FileViewMode = "code";

  @state() private _activeTab = 0;

  /** Track the file the active tab applies to so we reset on file change. */
  private _activeTabFile: string | null = null;

  private _storeCtrl = new StoreController(this);

  @query("file-viewer-code") private _codeViewer?: FileViewerCode;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._storeCtrl.store = this.store;
    }

    // Reset to the requested initial tab when the selected file changes.
    const path = this.store?.selectedFile ?? null;
    if (path !== this._activeTabFile) {
      this._activeTabFile = path;
      this._activeTab = this._initialTabIndex();
    } else if (path && changed.has("initialView")) {
      this._activeTab = this._initialTabIndex();
    }
  }

  private _initialTabIndex(): number {
    return this.initialView === "preview" ? 1 : 0;
  }

  /** Set a line range to highlight and scroll to in the code viewer. */
  setHighlightRange(range: { startLine: number; endLine: number }) {
    // Switch to code tab (always index 0 for text files).
    if (this._activeTab !== 0) {
      this._activeTab = 0;
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

  // ---- Renderer collection --------------------------------------------------

  /** Build the list of renderers that apply to the current file. */
  private _collectRenderers(path: string, store: FileBrowserStore): RendererDef[] {
    const renderers: RendererDef[] = [];

    // Text files always get a code renderer.
    if (!store.isBinary && store.fileContent != null) {
      renderers.push({
        tab: CODE_TAB,
        render: () => html`<file-viewer-code
          class="flex-1 overflow-auto min-h-0"
          .content=${store.fileContent}
          .path=${path}
        ></file-viewer-code>`,
      });
    }

    // Preview renderers (image, PDF, markdown, HTML).
    if (isImage(path) && store.contentUrl) {
      const filename = path.split("/").pop() ?? path;
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-image
          class="flex-1 min-h-0 flex flex-col"
          src=${store.contentUrl!}
          filename=${filename}
        ></file-viewer-image>`,
      });
    } else if (isPdf(path) && store.contentUrl) {
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-pdf
          class="flex-1 min-h-0 flex flex-col"
          src=${store.contentUrl!}
        ></file-viewer-pdf>`,
      });
    } else if (isMarkdown(path) && store.fileContent) {
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-markdown
          class="flex-1 min-h-0 flex flex-col"
          .content=${store.fileContent}
        ></file-viewer-markdown>`,
      });
    } else if (isHtml(path) && store.fileContent != null) {
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-html
          class="flex-1 min-h-0 flex flex-col"
          .content=${store.fileContent}
        ></file-viewer-html>`,
      });
    }

    // Binary fallback — only if no other renderer matched.
    if (renderers.length === 0) {
      renderers.push({
        tab: { label: "Binary" },
        render: () => html`<file-viewer-binary
          class="flex-1 min-h-0 flex flex-col"
          label=${store.fileContent ?? "Binary file"}
        ></file-viewer-binary>`,
      });
    }

    return renderers;
  }

  // ---- Render ---------------------------------------------------------------

  private _onTabChange(e: CustomEvent<number>) {
    this._activeTab = e.detail;
  }

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

    const renderers = this._collectRenderers(path, store);
    const activeIndex = Math.min(this._activeTab, renderers.length - 1);

    // Single renderer — no tab bar.
    if (renderers.length === 1) {
      return renderers[0].render();
    }

    // Multiple renderers — show tab bar.
    return html`
      <div class="flex-1 overflow-hidden min-h-0 flex flex-col">
        <view-mode-tabs
          class="shrink-0"
          .tabs=${renderers.map((r) => r.tab)}
          .activeIndex=${activeIndex}
          @tab-change=${this._onTabChange}
        ></view-mode-tabs>
        ${renderers[activeIndex].render()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer": FileViewer;
  }
}
