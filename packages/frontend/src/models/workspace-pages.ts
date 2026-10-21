import type { Inspector } from "./inspector.js";

export type MainWorkspacePane = "chat" | "changes";
export type WorkspacePane = "sessions" | MainWorkspacePane | "inspector";

/** The workspace's panes as mobile pages, left to right; the Inspector's tabs are pages from its place on. */
export const MOBILE_WORKSPACE_PANE_ORDER = [
  "sessions",
  "chat",
  "changes",
  "inspector",
] as const satisfies readonly WorkspacePane[];

/** The desktop center pane that shows alongside a pane. */
export function mainWorkspacePaneFor(pane: WorkspacePane): MainWorkspacePane {
  return pane === "changes" || pane === "inspector" ? "changes" : "chat";
}

export interface WorkspacePage {
  readonly pane: WorkspacePane;
  /** The Inspector tab the page shows, which committing to it focuses. */
  readonly tab: string | null;
}

export interface WorkspaceSwipeOffsets {
  /** The workspace surface's translateX, as a CSS length. */
  readonly surface: string;
  /** In pixels, how far the Inspector's track of tab panels is dragged; null at rest. */
  readonly inspector: number | null;
}

/**
 * The workspace's mobile pages: one per pane in `order` (which must hold "chat" and "inspector"), the
 * Inspector's being one per tab. The surface lays out one column per pane, so a swipe past the
 * Inspector's column moves the Inspector's tab panels instead, and its tab strip stays in place.
 */
export class WorkspacePages {
  private readonly inspectorPage: number;
  private readonly tabs: readonly string[];

  constructor(
    private readonly order: readonly WorkspacePane[],
    private readonly inspector: Pick<Inspector, "tabs" | "activeTab"> | null,
  ) {
    this.inspectorPage = order.indexOf("inspector");
    this.tabs = inspector?.tabs.map((tab) => tab.key) ?? [];
  }

  get count(): number {
    return this.inspectorPage + Math.max(1, this.tabs.length);
  }

  /** The Inspector's page is its active tab's; a pane without a page of its own shows Chat's. */
  pageOf(pane: WorkspacePane): number {
    if (pane === "inspector") {
      return this.inspectorPage + Math.max(0, this.tabs.indexOf(this.inspector?.activeTab.key ?? ""));
    }
    const page = this.order.indexOf(pane);
    return page === -1 ? this.order.indexOf("chat") : page;
  }

  at(page: number): WorkspacePage {
    if (page >= this.inspectorPage) return { pane: "inspector", tab: this.tabs[page - this.inspectorPage] ?? null };
    return { pane: this.order[page] ?? "chat", tab: null };
  }

  /**
   * Where the surface and the Inspector's track sit on `page`, or, during a swipe, how a drag's
   * `translateX` (in pages of `width` pixels) splits between them.
   */
  offsets(page: number, translateX: number | null, width: number): WorkspaceSwipeOffsets {
    if (translateX == null) return { surface: `${-Math.min(page, this.inspectorPage) * 100}%`, inspector: null };
    const inspectorStart = -this.inspectorPage * width;
    return { surface: `${Math.max(translateX, inspectorStart)}px`, inspector: Math.min(0, translateX - inspectorStart) };
  }
}
