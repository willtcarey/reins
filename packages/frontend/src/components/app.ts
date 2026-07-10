/**
 * App Shell — thin root component.
 *
 * Creates the AppStore and WebSocket client, wires shell controllers,
 * and renders views. All server communication and event handling lives
 * in AppStore — this component only owns UI-local concerns (active pane,
 * file tree state, document title).
 *
 * Routes:
 *  - `#/session/:sessionId` — view a specific session
 *  - (empty hash)           — no project selected, show empty state
 */

import { LitElement, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, state, query } from "lit/decorators.js";
import { AppClient } from "../models/ws-client.js";
import type { DiffRendererShell } from "./changes/diff-renderer-shell.js";
import { FileTreeState } from "../models/changes/file-tree-state.js";
import { AppRouteController } from "../controllers/app-route-controller.js";
import { PageSwipeController } from "../controllers/page-swipe-controller.js";
import { ViewportController } from "../controllers/viewport-controller.js";
import { AppStore } from "../models/stores/app-store.js";
import type { DiffRenderer } from "../models/stores/settings-store.js";
// Ensure sub-components are registered
import type {
  MainPaneSelectDetail,
  MainWorkspacePane,
  OpenImageViewerDetail,
  OpenInBrowserDetail,
  WorkspacePane,
} from "./events.js";
import "./app-main-toolbar.js";
import "./chat-panel.js";
import "./changes/diff-file-tree.js";
import "./changes/diff-renderer-shell.js";
import "./session-sidebar.js";
import "./quick-open.js";
import type { QuickOpen } from "./quick-open.js";
import { QuickOpenStore } from "../models/stores/quick-open-store.js";
import "./file-search.js";
import type { FileSearch } from "./file-search.js";
import "./file-viewer/file-browser.js";
import type { FileBrowser } from "./file-viewer/file-browser.js";
import { FileBrowserStore } from "../models/stores/file-browser-store.js";
import { setProjectDir, toRelativePath } from "../models/path-utils.js";
import "./image-lightbox.js";
import type { ImageLightbox } from "./image-lightbox.js";
import "./settings/panel.js";
import type { SettingsPanel } from "./settings/panel.js";

type WorkspacePanes = Record<WorkspacePane, unknown>;

const MOBILE_WORKSPACE_PANE_ORDER = [
  "sessions",
  "chat",
  "changes",
  "files",
] as const satisfies readonly WorkspacePane[];

function mainWorkspacePaneFor(pane: WorkspacePane): MainWorkspacePane {
  return pane === "changes" || pane === "files" ? "changes" : "chat";
}

@customElement("app-shell")
export class AppShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private appStore = new AppStore(new AppClient());
  private fileTreeState = new FileTreeState();
  private _unsubscribeStore: (() => void) | null = null;
  private viewport = new ViewportController(this);
  private routes = new AppRouteController(this, {
    store: this.appStore,
    onSessionChange: () => { this.activePane = "chat"; },
    onProjectChange: () => {
      this.fileTreeState.reset();
      this.activeDiffFile = null;
    },
    onSessionVisit: (sessionId) => this.quickOpenStore.recordVisit(sessionId),
  });

  @state() private activePane: WorkspacePane = "chat";
  @state() private activeDiffFile: string | null = null;
  /** Bumped on every store notification to trigger a re-render. */
  @state() private _storeVersion = 0;
  private quickOpenStore = new QuickOpenStore();
  @query("quick-open") private _quickOpen!: QuickOpen;
  private fileBrowserStore = new FileBrowserStore();
  @query("file-search") private _fileSearch!: FileSearch;
  @query("file-browser") private _fileBrowser!: FileBrowser;
  @query("image-lightbox") private _imageLightbox!: ImageLightbox;
  @query("settings-panel") private _settingsPanel!: SettingsPanel;
  private pageSwipe = new PageSwipeController(this, {
    pageCount: MOBILE_WORKSPACE_PANE_ORDER.length,
    getPage: () => this.pageForPane(this.activePane),
    commitPage: (page) => { this.activePane = this.paneForPage(page); },
    isEnabled: () => this.viewport.isMobileLayout,
  });

  override connectedCallback() {
    super.connectedCallback();

    // Subscribe to app store changes (covers project store + activity)
    this._unsubscribeStore = this.appStore.subscribe(() => {
      this._storeVersion++;
      this.fileBrowserStore.projectId = this.appStore.projectId;
      // Keep path-utils aware of the current project directory so
      // absolute paths inside the project are treated as browsable.
      const pid = this.appStore.projectId;
      const proj = pid != null ? this.appStore.projects.find(p => p.id === pid) : null;
      setProjectDir(proj?.path ?? null);
      this.updateTitleAndFavicon();
    });

    this.routes.connect();

    // Listen for open-in-browser events dispatched on document (e.g. from
    // agent-triggered ui.openFile() via WS). Events from child components
    // bubble to the template handler; document-level events need this listener.
    document.addEventListener("open-in-browser", this.handleOpenInBrowser);

    // When the user returns to the tab, mark the active session as viewed so
    // any finished/unread activity that accumulated while away is cleared.
    //
    // In Tauri the Rust side also dispatches visibilitychange on document when
    // the window gains/loses focus (the Page Visibility API doesn't fire
    // reliably on all webview backends).
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    this.appStore.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeStore?.();
    document.removeEventListener("open-in-browser", this.handleOpenInBrowser);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.appStore.disconnect();
    this.appStore.dispose();
  }

  /**
   * When the user returns to the tab, mark the active session as viewed.
   * This clears any finished/unread activity that accumulated while the
   * window was in the background.
   */
  private handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      void this.appStore.activeSessionStore?.markViewed();
    }
  };

  private updateTitleAndFavicon(): void {
    const { running, finished } = this.appStore.activitySummary;

    if (running > 0) {
      document.title = `(${running} running) REINS`;
    } else if (finished > 0) {
      document.title = `(${finished} new) REINS`;
    } else {
      document.title = "REINS";
    }
  }

  private getDiffPanel(): DiffRendererShell | null {
    return this.querySelector("diff-renderer-shell");
  }

  /**
   * Handle file selection from a layout-owned file tree:
   * switch to the Changes tab, then scroll to that file's diff card.
   */
  private handleChatFileSelect(e: CustomEvent<string>) {
    e.stopPropagation();
    const path = e.detail;
    this.activePane = "changes";
    requestAnimationFrame(() => {
      this.getDiffPanel()?.scrollToFile(path);
    });
  }

  /** Handle `open-in-browser` events — from child components (bubbling) and agent-triggered (document dispatch). */
  private handleOpenInBrowser = (e: CustomEvent<OpenInBrowserDetail>) => {
    const { startLine, endLine, viewMode } = e.detail;
    // Normalise absolute project paths to relative before opening
    const path = toRelativePath(e.detail.path);
    if (!path) return;
    this._fileBrowser?.openFile(
      path,
      startLine != null && endLine != null ? { startLine, endLine } : undefined,
      viewMode,
    );
  }

  private handleOpenImageViewer = (e: CustomEvent<OpenImageViewerDetail>) => {
    this._imageLightbox?.show(e.detail);
  };

  private handleMainPaneSelect(e: CustomEvent<MainPaneSelectDetail>) {
    this.activePane = e.detail.pane;
  }

  private pageForPane(pane: WorkspacePane) {
    const page = MOBILE_WORKSPACE_PANE_ORDER.indexOf(pane);
    return page === -1 ? MOBILE_WORKSPACE_PANE_ORDER.indexOf("chat") : page;
  }

  private paneForPage(page: number): WorkspacePane {
    return MOBILE_WORKSPACE_PANE_ORDER[page] ?? "chat";
  }

  private openQuickOpen() {
    this._quickOpen?.open();
  }

  private openFileSearch() {
    this._fileSearch?.open();
  }

  private openSettings() {
    this._settingsPanel?.open();
  }

  private activityForSession = (projectId: number, sessionId: string) => {
    return this.appStore.projectsStore.activityForSession(projectId, sessionId);
  };

  private renderSessionSidebar(store: AppStore) {
    return html`
      <session-sidebar
        class="block h-full"
        .store=${store}
        @select-session=${() => { this.activePane = "chat"; }}
      ></session-sidebar>
    `;
  }

  private renderMainToolbar(store: AppStore, activePane: MainWorkspacePane) {
    return html`
      <app-main-toolbar
        .activePane=${activePane}
        .currentBranch=${store.diffStore.branch}
        .isStandalone=${this.viewport.isStandalone}
        .connected=${store.connected}
        show-sidebar-button
        @open-file-browser=${() => this._fileBrowser?.open()}
        @pane-select=${(e: CustomEvent<MainPaneSelectDetail>) => this.handleMainPaneSelect(e)}
        @reload-request=${() => location.reload()}
      ></app-main-toolbar>
    `;
  }

  private renderChatPane(store: AppStore, visible: boolean) {
    if (!store.activeSessionStore) return nothing;

    return keyed(store.sessionId, html`
      <chat-panel
        class="block h-full min-h-0 min-w-0"
        .store=${store.activeSessionStore}
        .projectStore=${store.activeProjectStore}
        ?visible=${visible}
      ></chat-panel>
    `);
  }

  private renderChangesPane(store: AppStore, diffRenderer: DiffRenderer, visible: boolean) {
    return keyed(store.projectId, html`
      <diff-renderer-shell
        class="block h-full min-h-0 min-w-0"
        .store=${store.diffStore}
        .renderer=${diffRenderer}
        .visible=${visible}
        @active-file-change=${(e: CustomEvent<string | null>) => { this.activeDiffFile = e.detail; }}
      ></diff-renderer-shell>
    `);
  }

  private renderFileTree(store: AppStore) {
    return html`
      <diff-file-tree
        class="block h-full min-h-0 flex-1"
        data-swipe-surface
        .store=${store.diffStore}
        .treeState=${this.fileTreeState}
        .activeFile=${this.activeDiffFile}
        @file-select=${(e: CustomEvent<string>) => this.handleChatFileSelect(e)}
      ></diff-file-tree>
    `;
  }

  private renderWorkspacePanes(
    store: AppStore,
    diffRenderer: DiffRenderer,
  ): WorkspacePanes {
    const activeMainPane = mainWorkspacePaneFor(this.activePane);

    const swipeActive = this.pageSwipe.dragging || this.pageSwipe.settling;

    return {
      sessions: this.renderSessionSidebar(store),
      chat: this.renderChatPane(store, this.viewport.isMobileLayout || activeMainPane === "chat" || swipeActive),
      changes: this.renderChangesPane(store, diffRenderer, this.viewport.isMobileLayout || activeMainPane === "changes" || swipeActive),
      files: this.renderFileTree(store),
    };
  }

  private renderWorkspace(store: AppStore, panes: WorkspacePanes) {
    const activeMainPane = mainWorkspacePaneFor(this.activePane);
    this.pageSwipe.syncPage();
    const page = this.pageForPane(this.activePane);
    const swipeTranslateX = this.pageSwipe.translateX == null
      ? `${-page * 100}%`
      : `${this.pageSwipe.translateX}px`;
    const gridStyle = `grid-template-columns: repeat(${MOBILE_WORKSPACE_PANE_ORDER.length}, 100%); transform: translate3d(${swipeTranslateX}, 0, 0);`;

    return html`
      <div
        class="relative h-full min-h-0 min-w-0 overflow-clip swipe-shell"
        data-workspace-shell
        @click=${this.pageSwipe.clickCaptureHandler}
        @pointerdown=${this.pageSwipe.handlePointerDown}
        @pointermove=${this.pageSwipe.handlePointerMove}
        @pointerup=${this.pageSwipe.handlePointerEnd}
        @pointercancel=${this.pageSwipe.handlePointerCancel}
      >
        <div
          class="workspace-surface grid h-full min-h-0 min-w-0 grid-rows-[50px_minmax(0,1fr)] md:!transform-none md:![grid-template-columns:auto_minmax(0,1fr)_15rem] md:grid-rows-[50px_minmax(0,1fr)]"
          data-dragging=${this.pageSwipe.dragging || this.pageSwipe.settling ? "true" : "false"}
          style=${gridStyle}
        >
          <div class="z-20 col-start-2 row-start-1 min-w-0 overflow-hidden md:col-start-2 md:row-start-1 ${activeMainPane === "chat" ? "md:block" : "md:hidden"}">
            ${this.renderMainToolbar(store, "chat")}
          </div>
          <div class="z-20 col-start-3 row-start-1 min-w-0 overflow-hidden md:col-start-2 md:row-start-1 ${activeMainPane === "changes" ? "md:block" : "md:hidden"}">
            ${this.renderMainToolbar(store, "changes")}
          </div>
          <section class="col-start-1 row-start-1 row-span-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-1 md:row-start-1 md:row-span-2">
            ${panes.sessions}
          </section>
          <section class="col-start-2 row-start-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-2 md:row-start-2 ${activeMainPane === "chat" ? "" : "md:hidden"}">
            ${panes.chat}
          </section>
          <section class="col-start-3 row-start-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-2 md:row-start-2 ${activeMainPane === "changes" ? "" : "md:hidden"}">
            ${panes.changes}
          </section>
          <section class="col-start-4 row-start-1 row-span-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-3 md:row-start-1 md:row-span-2 md:border-l md:border-zinc-700">
            ${panes.files}
          </section>
        </div>
      </div>
    `;
  }

  private renderEmptyState() {
    return html`
      <div class="flex-1 flex flex-col">
        <div class="flex-1 flex items-center justify-center">
        <div class="text-center max-w-md px-6">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
               class="mx-auto mb-4 text-zinc-600">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
          </svg>
          <h2 class="text-lg font-medium text-zinc-400 mb-2">No project selected</h2>
          <p class="text-sm text-zinc-500">
            Select a project from the sidebar or add a new one to get started.
          </p>
        </div>
        </div>
      </div>
    `;
  }

  override render() {
    // Read from store (the _storeVersion state ensures re-renders on changes)
    void this._storeVersion;
    const store = this.appStore;
    const activeSessionStore = store.activeSessionStore;
    const hasProject = store.projectId != null && activeSessionStore != null;
    const diffRenderer: DiffRenderer = store.settingsStore.diffRenderer;
    const panes = hasProject ? this.renderWorkspacePanes(store, diffRenderer) : null;

    return html`
      <div class="h-dvh w-full flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden"
        @open-quick-open=${() => this.openQuickOpen()}
        @open-file-search=${() => this.openFileSearch()}
        @open-image-viewer=${this.handleOpenImageViewer}
        @open-settings=${() => this.openSettings()}>
        <!-- Connection status bar -->
        ${!store.connected ? html`
          <div class="bg-yellow-800 text-yellow-200 text-xs text-center py-1">
            Connecting to server...
          </div>
        ` : ""}

        <!-- Main layout: one responsive grid with swipe navigation -->
        <div class="flex-1 min-h-0 min-w-0 overflow-hidden">
          ${hasProject && panes ? html`
            ${this.renderWorkspace(store, panes)}
          ` : html`
            <div class="h-full flex min-h-0 min-w-0 overflow-hidden">
              <session-sidebar .store=${store}></session-sidebar>
              ${this.renderEmptyState()}
            </div>
          `}
        </div>

        <!-- Quick-open overlay -->
        <quick-open
          .activityForSession=${this.activityForSession}
          .store=${this.quickOpenStore}
        ></quick-open>

        <!-- File search palette (Cmd+P) -->
        <file-search
          .store=${this.fileBrowserStore}
        ></file-search>

        <!-- File viewer overlay -->
        <file-browser
          .store=${this.fileBrowserStore}
        ></file-browser>

        <!-- Image preview overlay -->
        <image-lightbox></image-lightbox>

        <!-- Settings panel overlay -->
        <settings-panel .store=${store.settingsStore}></settings-panel>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
