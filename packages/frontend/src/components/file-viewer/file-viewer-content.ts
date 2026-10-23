/**
 * The file viewer's content: a file shown by the renderers that apply to its type, with Code/Preview
 * tabs when more than one does.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { TemplateResult } from "lit";
import type { FileContent } from "../../models/file-loader.js";
import type { FileViewerMode } from "reins-sdk/contract";
import { isMarkdown, isImage, isPdf, isHtml } from "../../models/changes/diff-utils.js";
import { fileViewerModeChangeEvent } from "../events.js";
import { codeIcon, previewIcon } from "../../ui/icons.js";
import "./file-viewer-image.js";
import "./file-viewer-pdf.js";
import "./file-viewer-binary.js";
import "./file-viewer-markdown.js";
import "./file-viewer-html.js";
import "./file-viewer-code.js";
import "../view-mode-tabs.js";
import type { TabDef } from "../view-mode-tabs.js";
import type { HighlightRequest } from "./file-viewer-code.js";

interface RendererDef {
  tab: TabDef;
  render: () => TemplateResult;
}

const CODE_TAB: TabDef = {
  label: "Code",
  icon: codeIcon(),
};

const PREVIEW_TAB: TabDef = {
  label: "Preview",
  icon: previewIcon(),
};

@customElement("file-viewer-content")
export class FileViewerContent extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() path = "";
  @property({ attribute: false }) file: FileContent | undefined = undefined;
  @property({ attribute: false }) contentUrl: string | null = null;

  @property() initialMode: FileViewerMode = "code";

  @property({ attribute: false }) highlightRequest: HighlightRequest | null = null;

  @state() private _activeTab = 0;
  private _appliedRequest: HighlightRequest | null = null;
  private _renderers: RendererDef[] = [];

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("path") || changed.has("initialMode")) {
      this._activeTab = this.initialMode === "preview" ? 1 : 0;
    }
    // Lines are shown in the code tab, which is always first.
    const request = this.highlightRequest;
    if (request && request !== this._appliedRequest) {
      this._appliedRequest = request;
      this._activeTab = 0;
    }
  }

  // ---- Renderer collection --------------------------------------------------

  /** Build the list of renderers that apply to the current file. */
  private _collectRenderers(path: string, file: FileContent): RendererDef[] {
    const renderers: RendererDef[] = [];
    const contentUrl = this.contentUrl;
    const text = file.text;

    // Text files always get a code renderer.
    if (!file.isBinary && text != null) {
      renderers.push({
        tab: CODE_TAB,
        render: () => html`<file-viewer-code
          class="flex-1 overflow-auto min-h-0 bg-zinc-950"
          .content=${text}
          .path=${path}
          .highlightRequest=${this.highlightRequest}
        ></file-viewer-code>`,
      });
    }

    // Preview renderers (image, PDF, markdown, HTML).
    if (isImage(path) && contentUrl) {
      const filename = path.split("/").pop() ?? path;
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-image
          class="flex-1 min-h-0 flex flex-col"
          src=${contentUrl}
          filename=${filename}
        ></file-viewer-image>`,
      });
    } else if (isPdf(path) && contentUrl) {
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-pdf
          class="flex-1 min-h-0 flex flex-col"
          src=${contentUrl}
        ></file-viewer-pdf>`,
      });
    } else if (isMarkdown(path) && text) {
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-markdown
          class="flex-1 min-h-0 flex flex-col"
          .content=${text}
        ></file-viewer-markdown>`,
      });
    } else if (isHtml(path) && text != null) {
      renderers.push({
        tab: PREVIEW_TAB,
        render: () => html`<file-viewer-html
          class="flex-1 min-h-0 flex flex-col"
          .content=${text}
        ></file-viewer-html>`,
      });
    }

    // Binary fallback — only if no other renderer matched.
    if (renderers.length === 0) {
      renderers.push({
        tab: { label: "Binary" },
        render: () => html`<file-viewer-binary
          class="flex-1 min-h-0 flex flex-col"
          label=${text ?? "Binary file"}
        ></file-viewer-binary>`,
      });
    }

    return renderers;
  }

  // ---- Render ---------------------------------------------------------------

  private _onTabChange(e: CustomEvent<number>) {
    this._activeTab = e.detail;
    const tab = this._renderers[e.detail]?.tab;
    if (tab) this.dispatchEvent(fileViewerModeChangeEvent(tab === PREVIEW_TAB ? "preview" : "code"));
  }

  override render() {
    const file = this.file;
    if (!file || !this.path) return nothing;

    if (file.loading) {
      return html`<div class="flex-1 overflow-auto min-h-0">
        <div class="px-4 py-8 text-center text-sm text-zinc-500">Loading...</div>
      </div>`;
    }

    if (file.error) {
      return html`<div class="flex-1 overflow-auto min-h-0">
        <div class="px-4 py-8 text-center text-sm text-red-400">${file.error}</div>
      </div>`;
    }

    const renderers = this._collectRenderers(this.path, file);
    this._renderers = renderers;
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
    "file-viewer-content": FileViewerContent;
  }
}
