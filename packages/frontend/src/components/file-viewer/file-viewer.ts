import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Disposer, Files, ReinsSdk, Source } from "@reins/sdk";
import { StoreController } from "../../controllers/store-controller.js";
import { FileLoader } from "../../models/file-loader.js";
import { downloadIcon, fileIcon, navigationFolderIcon, paneIcon, panelRightIcon } from "../../ui/icons.js";
import { openInBrowserEvent, openInInspectorEvent } from "../events.js";
import type { HighlightRequest } from "./file-viewer-code.js";
import "./file-viewer-content.js";

/** Which of a file's tabs shows it: its code, or a preview (Markdown, HTML, images, PDFs). */
export type FileViewerMode = "code" | "preview";

/** The `file` view, which this feature registers: one file of a source, at some lines, in a mode. */
export type FileView = { view: "file"; source: Source; path: string; startLine?: number; endLine?: number; mode?: FileViewerMode };

/** Where a file viewer is shown; its header offers to open the file in the other one. */
export type FileViewerContainer = "inspector" | "file-browser";

/**
 * One file of a source, loaded by the viewer itself, under a header with its path and actions. It is
 * the `file` view's pane, and the file browser shows one too. A new `view` object (each open) reads
 * the file again and reveals its lines.
 */
@customElement("file-viewer")
export class FileViewer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) view: FileView | null = null;
  @property({ attribute: false }) files: Files | null = null;
  @property() container: FileViewerContainer = "inspector";

  /** The Code/Preview tab shown, which an open in the other container carries. */
  @state() private mode: FileViewerMode = "code";

  private loader: FileLoader | null = null;
  private loaderController = new StoreController<FileLoader>(this);
  private highlight: HighlightRequest | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated && !this.loader) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.loader?.dispose();
    this.loader = null;
    this.loaderController.store = null;
  }

  override willUpdate(changed: Map<string, unknown>) {
    const { files, view } = this;
    if (!files) return;
    const fresh = !this.loader;
    if (!this.loader) {
      this.loader = new FileLoader(files);
      this.loaderController.store = this.loader;
    }
    if (changed.has("view")) {
      this.highlight = view?.startLine == null ? null : { startLine: view.startLine, endLine: view.endLine ?? view.startLine };
      // Lines are shown in the Code tab.
      this.mode = this.highlight ? "code" : view?.mode ?? "code";
    }
    if (view && (fresh || changed.has("view"))) this.loader.show(view.source, view.path, { reload: true });
  }

  /** The file as shown: its lines and the tab the user is on. */
  get shown(): FileView | null {
    const view = this.view;
    if (!view) return null;
    const lines = this.highlight ? { startLine: this.highlight.startLine, endLine: this.highlight.endLine } : {};
    return { view: "file", source: view.source, path: view.path, ...lines, ...(this.mode === "preview" ? { mode: this.mode } : {}) };
  }

  private openElsewhere() {
    const shown = this.shown;
    if (!shown) return;
    if (this.container === "file-browser") {
      this.dispatchEvent(openInInspectorEvent(shown));
      return;
    }
    const { source, path, startLine, endLine } = shown;
    this.dispatchEvent(openInBrowserEvent(source, path, { startLine, endLine, mode: this.mode }));
  }

  private renderOpenElsewhere(path: string) {
    const button = "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md p-1 text-zinc-500 outline-none hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-500/60";
    if (this.container === "file-browser") {
      return html`<button class=${button} title="Open in Inspector" @click=${() => this.openElsewhere()}>
        ${panelRightIcon("", 14)}<span class="sr-only sm:not-sr-only">Open in Inspector</span>
      </button>`;
    }
    return html`<button
      class=${button}
      title="Open in file browser"
      aria-label=${`Open ${path} in file browser`}
      @click=${() => this.openElsewhere()}
    >${navigationFolderIcon("", 14)}</button>`;
  }

  override render() {
    const view = this.view;
    if (!view) return nothing;
    const { path, source } = view;
    const nameStart = path.lastIndexOf("/") + 1;
    const downloadUrl = this.files?.contentUrl(source, path, { download: true });
    return html`
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-800 pl-3 pr-1.5 font-mono text-xs">
        <span class="mr-1 flex min-w-0 flex-1" title=${path}>
          ${nameStart > 0 ? html`<span class="min-w-0 truncate text-zinc-500 [direction:rtl]"><bdi>${path.slice(0, nameStart)}</bdi></span>` : nothing}
          <span class="max-w-full shrink-0 truncate text-zinc-300">${path.slice(nameStart)}</span>
        </span>
        ${this.renderOpenElsewhere(path)}
        ${downloadUrl ? html`<a
          class="shrink-0 cursor-pointer rounded-md p-1 text-zinc-500 outline-none hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-500/60"
          href=${downloadUrl}
          download=${path.slice(nameStart) || path}
          title="Download file"
          aria-label=${`Download ${path}`}
          @click=${(e: Event) => e.stopPropagation()}
        >${downloadIcon("", 14)}</a>` : nothing}
      </div>
      <file-viewer-content
        class="flex min-h-0 min-w-0 flex-1 flex-col"
        .path=${path}
        .file=${this.loader?.content ?? undefined}
        .contentUrl=${this.files?.contentUrl(source, path) ?? null}
        .initialMode=${this.mode}
        .highlightRequest=${this.highlight}
        @file-viewer-mode-change=${(e: CustomEvent<FileViewerMode>) => { this.mode = e.detail; }}
      ></file-viewer-content>
    `;
  }
}

export function registerFileViewer(reins: ReinsSdk): Disposer {
  return reins.views.register("file", {
    key: (view) => `${view.source.nodeId}:${view.source.path}:${view.path}`,
    pane: {
      title: (view) => view.path.slice(view.path.lastIndexOf("/") + 1),
      description: (view) => view.path,
      icon: paneIcon(fileIcon),
      width: 640,
      mount(target, view) {
        const element = target.ownerDocument.createElement("file-viewer");
        element.setAttribute("class", "flex h-full min-h-0 flex-col");
        element.files = reins.files;
        element.view = view;
        target.append(element);
        return { update: (shown) => { element.view = shown; }, dispose: () => element.remove() };
      },
    },
  });
}

declare module "@reins/sdk" {
  interface ViewTypes {
    file: FileView;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer": FileViewer;
  }
}
