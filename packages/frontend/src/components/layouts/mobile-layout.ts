import { LitElement, html } from "lit";
import type { PropertyValues } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { SwipePagerPageChangeDetail } from "./swipe-pager.js";
import "./swipe-pager.js";
import type { SwipePager } from "./swipe-pager.js";

type MainWorkspacePane = "chat" | "changes";
type WorkspacePane = "sessions" | MainWorkspacePane | "files";
type WorkspacePanes = Record<WorkspacePane, unknown>;

const MOBILE_WORKSPACE_PANE_ORDER = [
  "sessions",
  "chat",
  "changes",
  "files",
] as const satisfies readonly WorkspacePane[];

export interface MobileLayoutPaneChangeDetail {
  pane: WorkspacePane;
}

@customElement("mobile-layout")
export class MobileLayout extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) activePane: WorkspacePane = "chat";
  @property({ attribute: false }) panes: Partial<WorkspacePanes> = {};

  @query("swipe-pager") private pager?: SwipePager;

  override updated(changed: PropertyValues<this>) {
    if (changed.has("activePane")) {
      this.pager?.goToPage(this.pageForPane(this.activePane));
    }
  }

  private pageForPane(pane: WorkspacePane) {
    const page = MOBILE_WORKSPACE_PANE_ORDER.indexOf(pane);
    return page === -1 ? MOBILE_WORKSPACE_PANE_ORDER.indexOf("chat") : page;
  }

  private paneForPage(page: number): WorkspacePane {
    return MOBILE_WORKSPACE_PANE_ORDER[page] ?? "chat";
  }

  private handlePageChange(e: CustomEvent<SwipePagerPageChangeDetail>) {
    const pane = this.paneForPage(e.detail.page);
    this.dispatchEvent(new CustomEvent<MobileLayoutPaneChangeDetail>("pane-change", {
      detail: { pane },
      bubbles: true,
      composed: true,
    }));
  }

  override render() {
    const pages = [
      this.panes.sessions,
      this.panes.chat,
      this.panes.changes,
      this.panes.files,
    ];

    return html`
      <swipe-pager
        class="block h-full min-h-0 min-w-0"
        .initialPage=${this.pageForPane(this.activePane)}
        .pages=${pages}
        @page-change=${(e: CustomEvent<SwipePagerPageChangeDetail>) => this.handlePageChange(e)}
      ></swipe-pager>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mobile-layout": MobileLayout;
  }
}
