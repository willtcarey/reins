import type { ChangeTypes } from "@pierre/diffs";
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { springCollapse } from "../../directives/spring-collapse.js";
import type { ReviewItem } from "../../models/changes/review-items.js";
import { diffRenderedEvent, toggleCollapseEvent } from "../events.js";
import {
  addedFileIcon,
  deletedFileIcon,
  modifiedFileIcon,
  renamedFileIcon,
} from "../icons.js";
import "./diff-file-action-buttons.js";
import { createReviewFileDiffRenderer } from "./review-file-diff-renderer.js";

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

@customElement("review-diff-item")
export class ReviewDiffItem extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) item: ReviewItem | null = null;
  @property({ type: Boolean }) collapsed = false;
  @property({ type: Number, attribute: false }) projectId: number | null = null;
  @property({ attribute: false }) branch: string | null = null;
  @property({ type: Number, attribute: false }) reservedHeight = 0;

  private readonly _diff = createReviewFileDiffRenderer(this, () => {
    this.dispatchEvent(diffRenderedEvent());
  });

  public get diffRendered(): boolean {
    if (!this.isConnected || typeof this.querySelector !== "function") return false;
    const article = this.querySelector("article");
    const container = this.querySelector<HTMLElement>("[data-pierre-file-diff]");
    const pre = container?.shadowRoot?.querySelector("pre");
    return article !== null
      && container !== null
      && container === this._diff.container
      && pre !== null
      && pre !== undefined
      && this._diff.rendered;
  }

  /** Only settled states may replace the coordinator's persistent estimate. */
  public get measurementStable(): boolean {
    if (!this.isConnected || typeof this.querySelector !== "function" || !this.querySelector("article")) return false;
    const transition = this.querySelector<HTMLElement>("[data-spring-collapse]");
    if (this.collapsed) return transition === null;
    return this.diffRendered && !transition?.style.height;
  }

  private _fileUrl(path: string): string {
    if (this.projectId == null) return "";
    let url = `/api/projects/${this.projectId}/files/content?path=${encodeURIComponent(path)}`;
    if (this.branch) url += `&ref=${encodeURIComponent(this.branch)}`;
    return url;
  }

  private _toggleCollapsed() {
    if (!this.item) return;
    this.dispatchEvent(toggleCollapseEvent(this.item.id));
  }

  override render() {
    const item = this.item;
    if (!item) return nothing;

    const diffBinding = this._diff.bind(item.fileDiff);
    const pendingHeight = !this.collapsed && !this.diffRendered && this.reservedHeight > 0
      ? `min-height:${this.reservedHeight}px`
      : nothing;

    return html`
      <article class="border-b border-zinc-700/70 bg-zinc-950" style=${pendingHeight}>
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
          () => html`<diffs-container data-pierre-file-diff ${diffBinding}></diffs-container>`,
          {
            onUnmount: () => this._diff.unmount(),
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
