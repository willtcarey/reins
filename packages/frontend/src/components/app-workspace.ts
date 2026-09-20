import { LitElement, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, property, state } from "lit/decorators.js";
import { PageSwipeController } from "../controllers/page-swipe-controller.js";
import { StoreController } from "../controllers/store-controller.js";
import { ViewportController } from "../controllers/viewport-controller.js";
import { FileTreeState } from "../models/changes/file-tree-state.js";
import type { AppStore } from "../models/stores/app-store.js";
import { WorkspaceStore } from "../models/stores/workspace-store.js";
import { folderIcon } from "../ui/icons.js";
import {
  openFileSearchEvent,
  type MainPaneSelectDetail,
  type MainWorkspacePane,
  type WorkspacePane,
} from "./events.js";
import type { ReviewDiffPanel } from "./changes/review-diff-panel.js";
import "./app-main-toolbar.js";
import "./chat-panel.js";
import "./changes/diff-file-tree.js";
import "./changes/review-diff-panel.js";
import "./session-sidebar.js";

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

@customElement("app-workspace")
export class AppWorkspace extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private storeController = new StoreController<WorkspaceStore>(this);
  private application: AppStore | null = null;
  private routedSessionId: string | null = null;

  @property({ attribute: false })
  set app(app: AppStore | null) {
    if (app === this.application) return;
    this.application = app;
    this.storeController.store?.dispose();
    this.storeController.store = app ? new WorkspaceStore(app) : null;
    if (this.storeController.store) void this.storeController.store.setSession(this.routedSessionId);
  }
  get app(): AppStore | null { return this.application; }

  @property({ attribute: false })
  set sessionId(sessionId: string | null) {
    if (sessionId === this.routedSessionId) return;
    this.routedSessionId = sessionId;
    void this.storeController.store?.setSession(sessionId);
  }
  get sessionId(): string | null { return this.routedSessionId; }

  get store(): WorkspaceStore | null { return this.storeController.store; }

  @state() private activePane: WorkspacePane = "chat";
  @state() private activeDiffFile: string | null = null;
  private observedSessionId = "";
  private observedProjectId: number | null = null;
  private fileTreeState = new FileTreeState();
  private viewport = new ViewportController(this);
  private pageSwipe = new PageSwipeController(this, {
    pageCount: MOBILE_WORKSPACE_PANE_ORDER.length,
    getPage: () => this.pageForPane(this.activePane),
    commitPage: (page) => { this.activePane = this.paneForPage(page); },
    isEnabled: () => this.viewport.isMobileLayout,
  });

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleGlobalKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.handleGlobalKeydown);
    this.storeController.store?.dispose();
    this.storeController.store = null;
    this.application = null;
  }

  override willUpdate() {
    const store = this.store;
    if (!store) return;
    if (store.sessionId && store.sessionId !== this.observedSessionId) {
      this.activePane = "chat";
    }
    if (store.projectId !== this.observedProjectId) {
      this.fileTreeState.reset();
      this.activeDiffFile = null;
    }
    this.observedSessionId = store.sessionId;
    this.observedProjectId = store.projectId;
  }

  private handleGlobalKeydown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "p") return;
    const projectId = this.store?.projectId;
    if (projectId == null) return;
    event.preventDefault();
    this.dispatchEvent(openFileSearchEvent(projectId));
  };

  private getDiffPanel(): ReviewDiffPanel | null {
    return this.querySelector("review-diff-panel");
  }

  private handleChatFileSelect(event: CustomEvent<string>) {
    event.stopPropagation();
    this.activePane = "changes";
    requestAnimationFrame(() => {
      this.getDiffPanel()?.scrollToFile(event.detail);
    });
  }

  private handleMainPaneSelect(event: CustomEvent<MainPaneSelectDetail>) {
    this.activePane = event.detail.pane;
  }

  private pageForPane(pane: WorkspacePane) {
    const page = MOBILE_WORKSPACE_PANE_ORDER.indexOf(pane);
    return page === -1 ? MOBILE_WORKSPACE_PANE_ORDER.indexOf("chat") : page;
  }

  private paneForPage(page: number): WorkspacePane {
    return MOBILE_WORKSPACE_PANE_ORDER[page] ?? "chat";
  }

  private renderSessionSidebar(store: WorkspaceStore) {
    return html`
      <session-sidebar
        class="block h-full"
        .store=${store}
        @select-session=${() => { this.activePane = "chat"; }}
      ></session-sidebar>
    `;
  }

  private renderMainToolbar(store: WorkspaceStore, activePane: MainWorkspacePane) {
    return html`
      <app-main-toolbar
        .projectId=${store.projectId}
        .activePane=${activePane}
        .currentBranch=${store.diffStore.branch}
        .isStandalone=${this.viewport.isStandalone}
        .connected=${store.connected}
        show-sidebar-button
        @pane-select=${(event: CustomEvent<MainPaneSelectDetail>) => this.handleMainPaneSelect(event)}
        @reload-request=${() => location.reload()}
      ></app-main-toolbar>
    `;
  }

  private renderChatPane(store: WorkspaceStore, visible: boolean) {
    if (!store.activeSessionStore) return nothing;

    const parentSessionId = store.activeSessionStore.sessionData.parentSessionId;
    const parentSession = parentSessionId
      ? store.activeProjectStore?.getSession(parentSessionId) ?? null
      : null;

    return keyed(store.sessionId, html`
      <chat-panel
        class="block h-full min-h-0 min-w-0"
        .store=${store.activeSessionStore}
        .projectStore=${store.activeProjectStore}
        .parentSession=${parentSession}
        .runningChildSessions=${store.activeProjectStore?.runningChildSessionsFor(store.sessionId) ?? []}
        .projectId=${store.projectId}
        .projectDir=${store.projectDir}
        ?visible=${visible}
      ></chat-panel>
    `);
  }

  private renderChangesPane(store: WorkspaceStore, visible: boolean) {
    return html`
      <review-diff-panel
        class="block h-full min-h-0 min-w-0"
        .store=${store.diffStore}
        .reviewStore=${store.codeReviewStore}
        .sessionId=${store.sessionId}
        .sessionRunning=${store.activeSessionStore?.sessionData?.activityState === "running"}
        .visible=${visible}
        @active-file-change=${(event: CustomEvent<string | null>) => { this.activeDiffFile = event.detail; }}
      ></review-diff-panel>
    `;
  }

  private renderFileTree(store: WorkspaceStore) {
    return html`
      <diff-file-tree
        class="block h-full min-h-0 flex-1"
        data-swipe-surface
        .store=${store.diffStore}
        .reviewStore=${store.codeReviewStore}
        .treeState=${this.fileTreeState}
        .activeFile=${this.activeDiffFile}
        @file-select=${(event: CustomEvent<string>) => this.handleChatFileSelect(event)}
      ></diff-file-tree>
    `;
  }

  private renderPanes(store: WorkspaceStore): WorkspacePanes {
    const activeMainPane = mainWorkspacePaneFor(this.activePane);
    const swipeActive = this.pageSwipe.dragging || this.pageSwipe.settling;
    const conversationVisible = this.viewport.isMobileLayout
      ? this.activePane === "chat"
      : activeMainPane === "chat";
    const hasSession = store.activeSessionStore != null;
    const hasProject = store.projectId != null;

    return {
      sessions: this.renderSessionSidebar(store),
      chat: hasSession ? this.renderChatPane(store, conversationVisible) : this.renderEmptyState(),
      changes: hasProject
        ? keyed(
            store.projectId,
            this.renderChangesPane(store, this.viewport.isMobileLayout || activeMainPane === "changes" || swipeActive),
          )
        : nothing,
      files: hasProject ? this.renderFileTree(store) : nothing,
    };
  }

  private renderEmptyState() {
    return html`
      <div class="flex-1 flex flex-col">
        <div class="flex-1 flex items-center justify-center">
          <div class="text-center max-w-md px-6">
            ${folderIcon("mx-auto mb-4 text-zinc-600", 48, 1.5)}
            <h2 class="text-lg font-medium text-zinc-400 mb-2">No project selected</h2>
            <p class="text-sm text-zinc-500">Select a project from the sidebar or add a new one to get started.</p>
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    const panes = this.renderPanes(store);
    const activeMainPane = mainWorkspacePaneFor(this.activePane);
    const hasSession = store.activeSessionStore != null;
    const hasProject = store.projectId != null;
    this.pageSwipe.syncPage();
    const page = this.pageForPane(this.activePane);
    const swipeTranslateX = this.pageSwipe.translateX == null
      ? `${-page * 100}%`
      : `${this.pageSwipe.translateX}px`;
    const gridStyle = `grid-template-columns: repeat(${MOBILE_WORKSPACE_PANE_ORDER.length}, 100%); transform: translate3d(${swipeTranslateX}, 0, 0);`;
    const desktopColumns = hasProject
      ? "md:![grid-template-columns:auto_minmax(0,1fr)_15rem]"
      : "md:![grid-template-columns:auto_minmax(0,1fr)_0]";

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
          class="workspace-surface grid h-full min-h-0 min-w-0 grid-rows-[50px_minmax(0,1fr)] md:!transform-none ${desktopColumns} md:grid-rows-[50px_minmax(0,1fr)]"
          data-dragging=${this.pageSwipe.dragging || this.pageSwipe.settling ? "true" : "false"}
          style=${gridStyle}
        >
          <div class="z-20 col-start-2 row-start-1 min-w-0 overflow-hidden md:col-start-2 md:row-start-1 ${activeMainPane === "chat" ? "md:block" : "md:hidden"}">
            ${hasSession ? this.renderMainToolbar(store, "chat") : nothing}
          </div>
          <div class="z-20 col-start-3 row-start-1 min-w-0 overflow-hidden md:col-start-2 md:row-start-1 ${activeMainPane === "changes" ? "md:block" : "md:hidden"}">
            ${hasProject ? this.renderMainToolbar(store, "changes") : nothing}
          </div>
          <section class="col-start-1 row-start-1 row-span-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-1 md:row-start-1 md:row-span-2">${panes.sessions}</section>
          <section class="col-start-2 row-start-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-2 md:row-start-2 ${activeMainPane === "chat" ? "" : "md:hidden"}">${panes.chat}</section>
          <section class="col-start-3 row-start-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-2 md:row-start-2 ${activeMainPane === "changes" ? "" : "md:hidden"}">${panes.changes}</section>
          <section class="col-start-4 row-start-1 row-span-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-3 md:row-start-1 md:row-span-2 ${hasProject ? "md:border-l md:border-zinc-700" : ""}">${panes.files}</section>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-workspace": AppWorkspace;
  }
}
