import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { FileLoader } from "../../models/file-loader.js";
import type { FileViewMode } from "../../models/inspector.js";
import type { FileSource, ProjectFiles } from "../../models/stores/project-files.js";
import { navigationFolderIcon } from "../../ui/icons.js";
import { openInBrowserEvent } from "../events.js";
import type { HighlightRequest } from "../file-viewer/file-viewer-code.js";
import "../file-viewer/file-viewer.js";

/** The `file` view: one file of the viewed session's source in the file viewer, loaded by the view itself. */
@customElement("inspector-file-view")
export class InspectorFileView extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) files: ProjectFiles | null = null;
  @property({ attribute: false }) source: FileSource | null = null;
  @property() path = "";
  @property({ attribute: false }) startLine: number | null = null;
  @property({ attribute: false }) endLine: number | null = null;
  @property() mode: FileViewMode = "code";
  /** Changes with every open of this view, which reads the file again and shows its lines again. */
  @property({ attribute: false }) revision = 0;

  private loader: FileLoader | null = null;
  private loaderController = new StoreController<FileLoader>(this);
  private highlight: HighlightRequest | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated && !this.loader) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.dropLoader();
  }

  override willUpdate(changed: Map<string, unknown>) {
    let fresh = false;
    if (changed.has("files") || !this.loader) {
      this.dropLoader();
      this.loader = this.files ? new FileLoader(this.files) : null;
      this.loaderController.store = this.loader;
      fresh = true;
    }
    const { loader, source } = this;
    if (!loader || !source || !this.path) return;
    if (fresh || changed.has("path") || changed.has("revision")) {
      loader.show(source, this.path, { reload: true });
      this.highlight = this.startLine == null
        ? null
        : { id: this.revision, startLine: this.startLine, endLine: this.endLine ?? this.startLine };
    } else if (changed.has("source")) {
      loader.show(source, this.path);
    }
  }

  private dropLoader() {
    this.loader?.dispose();
    this.loader = null;
    this.loaderController.store = null;
  }

  private openInFileBrowser() {
    if (!this.source) return;
    const lines = this.highlight ? { startLine: this.highlight.startLine, endLine: this.highlight.endLine } : {};
    this.dispatchEvent(openInBrowserEvent(this.source, this.path, { ...lines, mode: this.mode }));
  }

  override render() {
    const { files, source } = this;
    const nameStart = this.path.lastIndexOf("/") + 1;
    return html`
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800 pl-3 pr-1.5 font-mono text-xs">
        <span class="flex min-w-0 flex-1" title=${this.path}>
          ${nameStart > 0 ? html`<span class="min-w-0 truncate text-zinc-500 [direction:rtl]"><bdi>${this.path.slice(0, nameStart)}</bdi></span>` : nothing}
          <span class="max-w-full shrink-0 truncate text-zinc-300">${this.path.slice(nameStart)}</span>
        </span>
        <button
          class="shrink-0 cursor-pointer rounded-md p-1 text-zinc-500 outline-none hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-500/60"
          title="Open in file browser"
          aria-label=${`Open ${this.path} in file browser`}
          @click=${() => this.openInFileBrowser()}
        >${navigationFolderIcon("", 14)}</button>
      </div>
      <file-viewer
        class="flex min-h-0 min-w-0 flex-1 flex-col"
        .path=${this.path}
        .file=${this.loader?.content ?? undefined}
        .contentUrl=${files && source ? files.contentUrl(source, this.path) : null}
        .initialView=${this.mode}
        .highlightRequest=${this.highlight}
      ></file-viewer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "inspector-file-view": InspectorFileView;
  }
}
