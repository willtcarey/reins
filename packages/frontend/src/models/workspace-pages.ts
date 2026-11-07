import type { Inspector } from "./inspector.js";

/** Where the workspace is on a phone: the sessions, the main area (one page per tab) or the Inspector (one per tab). */
export type WorkspacePane = "sessions" | "main" | "inspector";

export interface WorkspacePage {
  readonly pane: WorkspacePane;
  /** The tab the page shows, which committing to it shows: a main-area tab's name, or an Inspector tab's key. */
  readonly tab: string | null;
}

export interface WorkspaceSwipeOffsets {
  /** The workspace surface's translateX, as a CSS length. */
  readonly surface: string;
  /** In pixels, how far the Inspector's track of tab panels is dragged; null at rest. */
  readonly inspector: number | null;
}

/** The main area's tabs, by view name, and the one shown; no tabs while it shows a view alone, or nothing. */
export interface MainTabs {
  readonly tabs: readonly string[];
  readonly active: string | null;
}

/**
 * The workspace's mobile pages: the sessions, then one per main-area tab (one page without tabs), then one per
 * Inspector tab (none without tabs). The surface lays out one column for the sessions, one for each main-area tab
 * and one for an Inspector with tabs, so a swipe past the Inspector's column moves the Inspector's tab panels
 * instead, and its tab strip stays in place.
 */
export class WorkspacePages {
  private readonly inspectorPage: number;
  private readonly inspectorTabs: readonly string[];

  constructor(
    private readonly main: MainTabs,
    private readonly inspector: Pick<Inspector, "tabs" | "activeTab">,
  ) {
    this.inspectorPage = 1 + Math.max(1, main.tabs.length);
    this.inspectorTabs = inspector.tabs.map((tab) => tab.key);
  }

  get count(): number {
    return this.inspectorPage + this.inspectorTabs.length;
  }

  /** The main area's page is its shown tab's, the Inspector's its active tab's (the main area's without tabs). */
  pageOf(pane: WorkspacePane): number {
    if (pane === "sessions") return 0;
    if (pane === "main" || this.inspectorTabs.length === 0) return 1 + Math.max(0, this.main.tabs.indexOf(this.main.active ?? ""));
    return this.inspectorPage + Math.max(0, this.inspectorTabs.indexOf(this.inspector.activeTab?.key ?? ""));
  }

  at(page: number): WorkspacePage {
    if (page <= 0) return { pane: "sessions", tab: null };
    if (page >= this.inspectorPage) return { pane: "inspector", tab: this.inspectorTabs[page - this.inspectorPage] ?? null };
    return { pane: "main", tab: this.main.tabs[page - 1] ?? null };
  }

  /**
   * Where the surface and the Inspector's track sit on `page`, or, during a swipe, how a drag's
   * `translateX` (in pages of `width` pixels) splits between them.
   */
  offsets(page: number, translateX: number | null, width: number): WorkspaceSwipeOffsets {
    if (translateX == null) return { surface: `${-Math.min(page, this.inspectorPage) * 100}%`, inspector: null };
    if (this.inspectorTabs.length === 0) return { surface: `${translateX}px`, inspector: null };
    const inspectorStart = -this.inspectorPage * width;
    return { surface: `${Math.max(translateX, inspectorStart)}px`, inspector: Math.min(0, translateX - inspectorStart) };
  }

  /** The surface's columns: the sessions, each main-area tab, an Inspector with tabs. */
  get columns(): number {
    return this.inspectorPage + (this.inspectorTabs.length > 0 ? 1 : 0);
  }
}
