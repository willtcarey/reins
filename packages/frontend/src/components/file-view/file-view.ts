import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Disposer, Files, ReinsSdk, ViewOf } from "reins-sdk/contract";
import { StoreController } from "../../controllers/store-controller.js";
import { FileLoader } from "../../models/file-loader.js";
import { navigationFolderIcon } from "../../ui/icons.js";
import { openInBrowserEvent } from "../events.js";
import type { HighlightRequest } from "../file-viewer/file-viewer-code.js";
import "../file-viewer/file-viewer.js";

/**
 * The `file` view, a built-in feature: one file of a source in the file viewer, loaded by the view
 * itself. A new `view` object (each open) reads the file again and reveals its lines.
 */
@customElement("inspector-file-view")
export class InspectorFileView extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) view: ViewOf<"file"> | null = null;
  @property({ attribute: false }) files: Files | null = null;

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
    }
    if (view && (fresh || changed.has("view"))) this.loader.show(view.source, view.path, { reload: true });
  }

  private openInFileBrowser() {
    const view = this.view;
    if (!view) return;
    const { source } = view;
    const lines = this.highlight ? { startLine: this.highlight.startLine, endLine: this.highlight.endLine } : {};
    this.dispatchEvent(openInBrowserEvent(source, view.path, { ...lines, mode: view.mode ?? "code" }));
  }

  override render() {
    const view = this.view;
    if (!view) return nothing;
    const { path, source } = view;
    const nameStart = path.lastIndexOf("/") + 1;
    return html`
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800 pl-3 pr-1.5 font-mono text-xs">
        <span class="flex min-w-0 flex-1" title=${path}>
          ${nameStart > 0 ? html`<span class="min-w-0 truncate text-zinc-500 [direction:rtl]"><bdi>${path.slice(0, nameStart)}</bdi></span>` : nothing}
          <span class="max-w-full shrink-0 truncate text-zinc-300">${path.slice(nameStart)}</span>
        </span>
        <button
          class="shrink-0 cursor-pointer rounded-md p-1 text-zinc-500 outline-none hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-500/60"
          title="Open in file browser"
          aria-label=${`Open ${path} in file browser`}
          @click=${() => this.openInFileBrowser()}
        >${navigationFolderIcon("", 14)}</button>
      </div>
      <file-viewer
        class="flex min-h-0 min-w-0 flex-1 flex-col"
        .path=${path}
        .file=${this.loader?.content ?? undefined}
        .contentUrl=${this.files?.contentUrl(source, path) ?? null}
        .initialView=${view.mode ?? "code"}
        .highlightRequest=${this.highlight}
      ></file-viewer>
    `;
  }
}

export function registerFileView(reins: ReinsSdk): Disposer {
  return reins.views.register("file", {
    pane: {
      title: (view) => view.path.slice(view.path.lastIndexOf("/") + 1),
      description: (view) => view.path,
      icon: "file",
      mount(target, view) {
        const element = target.ownerDocument.createElement("inspector-file-view");
        element.setAttribute("class", "flex h-full min-h-0 flex-col");
        element.files = reins.files;
        element.view = view;
        target.append(element);
        return { update: (shown) => { element.view = shown; }, dispose: () => element.remove() };
      },
    },
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "inspector-file-view": InspectorFileView;
  }
}
