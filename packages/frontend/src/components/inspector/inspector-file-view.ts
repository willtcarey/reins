import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import type { FileModel } from "../../models/stores/file-model.js";
import type { FileViewMode } from "../../models/inspector.js";
import type { FileSource } from "../../models/stores/project-files.js";
import { navigationFolderIcon } from "../../ui/icons.js";
import { openInBrowserEvent } from "../events.js";
import type { HighlightRequest } from "../file-viewer/file-viewer-code.js";
import "../file-viewer/file-viewer.js";

/** The `file` view: a file of the workspace's `FileModel` in the file viewer. */
@customElement("inspector-file-view")
export class InspectorFileView extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: FileModel | null = null;
  @property({ attribute: false }) source: FileSource | null = null;
  @property() path = "";
  @property({ attribute: false }) startLine: number | null = null;
  @property({ attribute: false }) endLine: number | null = null;
  @property() mode: FileViewMode = "code";
  /** Changes with every open of this view, which reads the file again and shows its lines again. */
  @property({ attribute: false }) revision = 0;

  private storeController = new StoreController<FileModel>(this);
  private highlight: HighlightRequest | null = null;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) this.storeController.store = this.store;
    const store = this.store;
    if (!store || !this.path) return;
    if (changed.has("path") || changed.has("revision")) {
      void store.loadFile(this.path, { refresh: true });
      this.highlight = this.startLine == null
        ? null
        : { id: this.revision, startLine: this.startLine, endLine: this.endLine ?? this.startLine };
    } else if (!store.file(this.path)) {
      // The model starts over for another source while this tab stays open.
      void store.loadFile(this.path);
    }
  }

  private openInFileBrowser() {
    if (!this.source) return;
    const lines = this.highlight ? { startLine: this.highlight.startLine, endLine: this.highlight.endLine } : {};
    this.dispatchEvent(openInBrowserEvent(this.source, this.path, { ...lines, mode: this.mode }));
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
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
        .file=${store.file(this.path)}
        .contentUrl=${store.contentUrl(this.path)}
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
