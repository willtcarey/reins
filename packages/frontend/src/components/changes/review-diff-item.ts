import { FileDiff, type ChangeTypes, type FileDiffOptions } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { springCollapse } from "../../directives/spring-collapse.js";
import { getPierreWorkerPool, PIERRE_SHIKI_THEME } from "../../models/changes/pierre-worker-pool.js";
import type { ReviewItem } from "../../models/changes/review-items.js";
import { diffRenderedEvent, toggleCollapseEvent } from "../events.js";
import {
  addedFileIcon,
  deletedFileIcon,
  modifiedFileIcon,
  renamedFileIcon,
} from "../icons.js";
import "./diff-file-action-buttons.js";

const STATUS_ICON_DETAILS: Record<ChangeTypes, {
  label: string;
  colorClass: string;
  icon: typeof modifiedFileIcon;
}> = {
  change: {
    label: "Modified file",
    colorClass: "text-sky-400",
    icon: modifiedFileIcon,
  },
  new: {
    label: "Added file",
    colorClass: "text-green-500",
    icon: addedFileIcon,
  },
  deleted: {
    label: "Deleted file",
    colorClass: "text-red-400",
    icon: deletedFileIcon,
  },
  "rename-pure": {
    label: "Renamed file",
    colorClass: "text-violet-400",
    icon: renamedFileIcon,
  },
  "rename-changed": {
    label: "Renamed file",
    colorClass: "text-violet-400",
    icon: renamedFileIcon,
  },
};

function renderStatusIcon(status: ChangeTypes) {
  const details = STATUS_ICON_DETAILS[status];
  return details.icon(`h-3 w-3 shrink-0 ${details.colorClass}`, details.label);
}

const REINS_DIFF_OPTIONS: FileDiffOptions<undefined> = {
  theme: PIERRE_SHIKI_THEME,
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  overflow: "scroll",
  hunkSeparators: "line-info",
  disableFileHeader: true,
};

@customElement("review-diff-item")
export class ReviewDiffItem extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) item: ReviewItem | null = null;
  @property({ type: Boolean }) collapsed = false;
  @property({ type: Number, attribute: false }) projectId: number | null = null;
  @property({ attribute: false }) branch: string | null = null;

  private _fileDiff: FileDiff<undefined> | null = null;
  private _renderedItem: ReviewItem | null = null;
  private _diffRendered = false;
  private _root: HTMLElement | null = null;

  public get diffRendered(): boolean {
    return this._diffRendered && this._renderedItem?.fileDiff === this.item?.fileDiff;
  }

  override updated() {
    this._syncFileDiff();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyFileDiff();
  }

  protected getDiffRoot(): HTMLElement | null {
    return this.querySelector<HTMLElement>("[data-pierre-file-diff]");
  }

  private _syncFileDiff() {
    const root = this.getDiffRoot();
    if (!root || !this.item) {
      this._destroyFileDiff();
      return;
    }
    if (this._fileDiff && this._root === root) {
      if (this._renderedItem?.fileDiff === this.item.fileDiff) {
        this._renderedItem = this.item;
        return;
      }
      this._diffRendered = false;
      this._renderedItem = this.item;
      this._fileDiff.render({ fileDiff: this.item.fileDiff, fileContainer: root });
      return;
    }

    this._destroyFileDiff();
    this._fileDiff = new FileDiff({
      ...REINS_DIFF_OPTIONS,
      onPostRender: (node, _instance, phase) => {
        if (phase === "unmount" || node.shadowRoot?.querySelector("[data-placeholder]")) return;
        this._markDiffRendered();
      },
    }, getPierreWorkerPool(), true);
    this._root = root;
    this._renderedItem = this.item;
    this._fileDiff.render({ fileDiff: this.item.fileDiff, fileContainer: root });
  }

  private _destroyFileDiff() {
    this._fileDiff?.cleanUp();
    this._fileDiff = null;
    this._root = null;
    this._renderedItem = null;
    this._diffRendered = false;
  }

  private _fileUrl(path: string): string {
    if (this.projectId == null) return "";
    let url = `/api/projects/${this.projectId}/files/content?path=${encodeURIComponent(path)}`;
    if (this.branch) url += `&ref=${encodeURIComponent(this.branch)}`;
    return url;
  }

  private _markDiffRendered() {
    this._diffRendered = true;
    this.dispatchEvent(diffRenderedEvent());
  }

  private _toggleCollapsed() {
    if (!this.item) return;
    this.dispatchEvent(toggleCollapseEvent(this.item.id));
  }

  override render() {
    const item = this.item;
    if (!item) return nothing;

    return html`
      <article class="border-b border-zinc-700/70 bg-zinc-950">
        <header class="reins-diff-header sticky top-0 z-10 flex min-w-0 items-center gap-2 px-3 py-2">
          <button
            type="button"
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200"
            aria-label=${`${this.collapsed ? "Expand" : "Collapse"} ${item.path}`}
            aria-expanded=${String(!this.collapsed)}
            @click=${this._toggleCollapsed}
          >
            <span aria-hidden="true">${this.collapsed ? "▶" : "▼"}</span>
          </button>
          ${renderStatusIcon(item.status)}
          ${item.oldPath && item.oldPath !== item.path
            ? html`
                <span class="reins-diff-path min-w-0 truncate font-mono text-sm text-zinc-500" title=${item.oldPath}>
                  <bdi>${item.oldPath}</bdi>
                </span>
                <span class="shrink-0 text-xs text-zinc-500" aria-hidden="true">→</span>
              `
            : nothing}
          <span class="reins-diff-path min-w-0 flex-1 truncate font-mono text-sm text-zinc-200" title=${item.path}>
            <bdi>${item.path}</bdi>
          </span>
          ${item.additions > 0 || item.removals > 0
            ? html`
                <span class="flex shrink-0 items-center gap-2 font-mono text-xs">
                  ${item.additions > 0 ? html`<span class="text-green-400">+${item.additions}</span>` : nothing}
                  ${item.removals > 0 ? html`<span class="text-red-400">-${item.removals}</span>` : nothing}
                </span>
              `
            : nothing}
          <span class="flex shrink-0 items-center gap-1">
            <diff-view-file-button .path=${item.path} variant="header"></diff-view-file-button>
            <diff-copy-path-button .path=${item.path} variant="header"></diff-copy-path-button>
            <diff-download-file-button
              .path=${item.path}
              .href=${this._fileUrl(item.path)}
              variant="header"
            ></diff-download-file-button>
          </span>
        </header>
        ${springCollapse(
          this.collapsed,
          () => html`<diffs-container data-pierre-file-diff></diffs-container>`,
          {
            onUnmount: () => this._destroyFileDiff(),
            animateContentResize: false,
          },
        )}
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-diff-item": ReviewDiffItem;
  }
}
