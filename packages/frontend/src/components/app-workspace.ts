import { LitElement, html, nothing, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, property, state } from "lit/decorators.js";
import { PageSwipeController } from "../controllers/page-swipe-controller.js";
import { StoreController } from "../controllers/store-controller.js";
import { ViewportController } from "../controllers/viewport-controller.js";
import { FileTreeState } from "../models/changes/file-tree-state.js";
import { WorkspaceLayout, type SidePane } from "../models/workspace-layout.js";
import type { AppStore } from "../models/stores/app-store.js";
import { WorkspaceStore } from "../models/stores/workspace-store.js";
import type { CurrentView, PaneContext, Source, View } from "@reins/sdk";
import { WorkspacePages, type WorkspacePane } from "../models/workspace-pages.js";
import { folderIcon } from "../ui/icons.js";
import { mainViewChangeEvent, openFileSearchEvent, openMainViewEvent, type MainPaneSelectDetail } from "./events.js";
import type { MainTab } from "./app-main-toolbar.js";
import type { ReviewDiffPanel } from "./changes/review-diff-panel.js";
import "./app-main-toolbar.js";
import type { ViewMount } from "./view-mount.js";
import "./view-mount.js";
import { registerDiffFileTree } from "./changes/diff-file-tree.js";
import { registerSessionViews } from "./session-views.js";
import "./app-inspector.js";
import "./session-sidebar.js";

@customElement("app-workspace")
export class AppWorkspace extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private storeController = new StoreController<WorkspaceStore>(this);
  private application: AppStore | null = null;

  @property({ attribute: false })
  set app(app: AppStore | null) {
    if (app === this.application) return;
    this.application = app;
    this.storeController.store?.dispose();
    // A new store follows the shown view's session once it renders (`followShownView`).
    this.storeController.store = app ? new WorkspaceStore(app) : null;
    // The session's views and the diff file tree are registered over this store.
    if (this.isConnected) this.connectApp();
  }
  get app(): AppStore | null { return this.application; }

  /**
   * The main area's view: its renderer's `pane`, in the main area with its tabs (`ViewRenderer.tabOf`), such as a
   * session's Chat and Changes, or alone (the new session page, an extension's page, a file). Null for nothing.
   */
  @property({ attribute: false }) mainView: View | null = null;

  get store(): WorkspaceStore | null { return this.storeController.store; }

  /** The view it shows and what that is about (`workspace.current()`), as the mounted view says; null when it shows none. */
  current(): CurrentView | null {
    if (!this.mainView) return null;
    return { view: this.mainView, subject: this.querySelector<ViewMount>("reins-view-mount[data-main-shown]")?.subject() ?? [] };
  }

  private appConnections: Array<() => void> = [];

  @state() private activePane: WorkspacePane = "main";
  /** The tab a swipe settled on, shown until the main area's view is that tab's. */
  @state() private swipedTab: string | null = null;
  private observedSessionId = "";
  private observedProjectId: number | null = null;
  private contexts: Record<"inspector" | "main", PaneContext> = {
    inspector: { source: null, container: "inspector" },
    main: { source: null, container: "main" },
  };
  private fileTreeState = new FileTreeState();
  private layout = new WorkspaceLayout(typeof localStorage === "undefined" ? null : localStorage, typeof navigator === "undefined" ? "browser" : navigator.userAgent ?? "browser");
  private resizePointer: { pane: SidePane; id: number; startX: number; startWidth: number } | null = null;

  private workspaceWidth() { return this.getBoundingClientRect().width || window.innerWidth; }
  private startResize(pane: SidePane, event: PointerEvent) {
    if (this.viewport.isMobileLayout || !event.isPrimary) return;
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture?.(event.pointerId);
    this.resizePointer = { pane, id: event.pointerId, startX: event.clientX, startWidth: this.layout.width(pane, this.workspaceWidth()) };
  }
  private moveResize(event: PointerEvent) {
    const drag = this.resizePointer;
    if (!drag || drag.id !== event.pointerId) return;
    this.layout.resize(drag.pane, drag.startWidth + (event.clientX - drag.startX) * (drag.pane === "sessions" ? 1 : -1), this.workspaceWidth());
    this.requestUpdate();
  }
  private endResize(event: PointerEvent) {
    if (this.resizePointer?.id !== event.pointerId) return;
    this.resizePointer = null;
    this.requestUpdate();
  }
  private resizeKey(pane: SidePane, event: KeyboardEvent) {
    if (this.viewport.isMobileLayout) return;
    if (event.key === "Home" || (event.key === "0" && (event.ctrlKey || event.metaKey))) this.layout.reset(pane);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") this.layout.resize(pane, this.layout.width(pane, this.workspaceWidth()) + (event.key === "ArrowRight" ? 10 : -10) * (pane === "sessions" ? 1 : -1), this.workspaceWidth());
    else return;
    event.preventDefault();
    this.requestUpdate();
  }
  private renderHandle(pane: SidePane) {
    return html`<div role="separator" aria-label="Resize ${pane === "sessions" ? "sessions pane" : "Inspector"}" aria-orientation="vertical" aria-valuenow=${this.layout.width(pane, this.workspaceWidth())} tabindex="0" data-resize-handle=${pane} class="hidden md:block absolute z-30 top-0 bottom-0 w-2 cursor-col-resize touch-none focus-visible:bg-blue-500/40" style=${pane === "sessions" ? `left: ${this.layout.width("sessions", this.workspaceWidth()) - 4}px` : `right: ${this.layout.width("inspector", this.workspaceWidth()) - 4}px`} @pointerdown=${(e: PointerEvent) => this.startResize(pane, e)} @pointermove=${this.moveResize} @pointerup=${this.endResize} @pointercancel=${this.endResize} @dblclick=${() => { this.layout.reset(pane); this.requestUpdate(); }} @keydown=${(e: KeyboardEvent) => this.resizeKey(pane, e)}></div>`;
  }
  private viewport = new ViewportController(this);
  private pageSwipe = new PageSwipeController(this, {
    pageCount: () => this.pages().count,
    getPage: () => this.pages().pageOf(this.activePane),
    commitPage: (page) => {
      const { pane, tab } = this.pages().at(page);
      this.activePane = pane;
      if (pane === "inspector" && tab) this.store?.inspector.focus(tab);
      if (pane === "main" && tab) this.showTab(tab);
    },
    isEnabled: () => this.viewport.isMobileLayout,
  });

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleGlobalKeydown);
    this.connectApp();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.handleGlobalKeydown);
    this.disconnectApp();
    this.storeController.store?.dispose();
    this.storeController.store = null;
    this.application = null;
  }

  override willUpdate(changed: PropertyValues<this>) {
    const store = this.store;
    if (!store) return;
    if ((store.sessionId && store.sessionId !== this.observedSessionId) || changed.has("mainView")) {
      this.activePane = "main";
      this.swipedTab = null;
    }
    if (store.projectId !== this.observedProjectId) this.fileTreeState.reset();
    this.observedSessionId = store.sessionId;
    this.observedProjectId = store.projectId;
  }

  protected override updated(): void {
    void this.followShownView();
  }

  /**
   * Once the shown view's mount has applied the view just rendered, follows the session it is about (the store's: the
   * Inspector's source, the diff and the review; none for a view about none), and says the main area changed.
   */
  private async followShownView(): Promise<void> {
    await this.querySelector<ViewMount>("reins-view-mount[data-main-shown]")?.updateComplete;
    const session = this.current()?.subject.find((subject) => subject.type === "session");
    void this.store?.setSession(typeof session?.id === "string" ? session.id : null);
    this.dispatchEvent(mainViewChangeEvent());
  }

  /** Brings the main area's page forward on a phone: opening a view there shows it, even the one shown already. */
  revealMain(): void {
    if (this.viewport.isMobileLayout) this.activePane = "main";
  }

  private handleGlobalKeydown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "p") return;
    const source = this.store?.source;
    if (!source) return;
    event.preventDefault();
    this.dispatchEvent(openFileSearchEvent(source));
  };

  private connectApp() {
    this.disconnectApp();
    const store = this.store;
    if (!store) return;
    const { app } = store;
    this.appConnections = [
      app.inspector.onOpen(() => { if (this.viewport.isMobileLayout) this.activePane = "inspector"; }),
      // A renderer registered later may change the Inspector's width, the main area's tabs, or show the view routed before it came.
      app.views.subscribe(() => this.requestUpdate()),
      registerSessionViews(app.views, store),
      registerDiffFileTree(app.views, { diffStore: store.diffStore, reviewStore: store.codeReviewStore, treeState: this.fileTreeState }),
    ];
  }

  private disconnectApp() {
    for (const disconnect of this.appConnections) disconnect();
    this.appConnections = [];
  }

  /** The same object while the source is, so views are not updated by every render. */
  private contextFor(source: Source | null, container: "inspector" | "main"): PaneContext {
    if (this.contexts[container].source !== source) this.contexts[container] = { source, container };
    return this.contexts[container];
  }

  /** The main area's tabs: the shown view's (`ViewRegistry.tabsFor`), the view alone when it is none's; none for nothing. */
  private mainTabs(): View[] {
    const views = this.store?.app.views;
    return this.mainView && views ? views.tabsFor(this.mainView) : [];
  }

  /** The tab on screen: the one a swipe settled on, until the route catches up, else the main area's view's. */
  private shownTab(): string | null {
    return this.swipedTab ?? this.mainView?.view ?? null;
  }

  /** Opens a tab's view in the main area (a history entry, as any open), and shows it meanwhile. */
  private showTab(name: string) {
    const tab = this.mainTabs().find((candidate) => candidate.view === name);
    if (!tab || name === this.shownTab()) return;
    this.swipedTab = name;
    this.dispatchEvent(openMainViewEvent(tab));
  }

  private getDiffPanel(): ReviewDiffPanel | null {
    return this.querySelector("review-diff-panel");
  }

  /** A changed file chosen (the Inspector's Changes tab): the session's Changes, scrolled to it. */
  private handleFileSelect(event: CustomEvent<string>) {
    event.stopPropagation();
    this.activePane = "main";
    this.showTab("session-changes");
    requestAnimationFrame(() => {
      this.getDiffPanel()?.scrollToFile(event.detail);
    });
  }

  private handleMainPaneSelect(event: CustomEvent<MainPaneSelectDetail>) {
    this.activePane = event.detail.pane;
  }

  private pages() {
    return new WorkspacePages({ tabs: this.mainTabs().map((tab) => tab.view), active: this.shownTab() }, this.store?.inspector ?? null);
  }

  private renderSessionSidebar(store: WorkspaceStore) {
    return html`
      <session-sidebar
        class="block h-full"
        .app=${store.app}
        .collapsed=${this.layout.sessionsCollapsed}
        .onToggleCollapse=${() => { this.layout.toggleSessions(); this.requestUpdate(); }}
      ></session-sidebar>
    `;
  }

  /** The tab's own toolbar (`PanePresentation.toolbar`), which the host's toolbar mounts; null without one. */
  private viewToolbar(store: WorkspaceStore, tab: View) {
    const presentation = store.app.views.rendererFor(tab)?.pane?.toolbar;
    return presentation ? { presentation, view: tab, context: this.contextFor(store.source, "main") } : null;
  }

  /** The toolbar over tab `index`: on a phone each tab's page has one, which marks its own tab. */
  private renderMainToolbar(store: WorkspaceStore, tabs: readonly View[], index: number) {
    const views = store.app.views;
    const context = this.contextFor(store.source, "main");
    const tab = tabs[index];
    const titled: MainTab[] = tabs.length > 1 ? tabs.map((view) => ({ view, title: views.titleOf(view, context) ?? view.view })) : [];
    return html`
      <app-main-toolbar
        .tabs=${titled}
        .activeTab=${index}
        .pageTitle=${tab ? views.titleOf(tab, context) : null}
        .viewToolbar=${tab ? this.viewToolbar(store, tab) : null}
        .isStandalone=${this.viewport.isStandalone}
        .connected=${store.connected}
        show-sidebar-button
        @pane-select=${(event: CustomEvent<MainPaneSelectDetail>) => this.handleMainPaneSelect(event)}
        @reload-request=${() => location.reload()}
      ></app-main-toolbar>
    `;
  }

  /** A tab's view, mounted from its renderer's pane; unavailable until one is registered. */
  private renderTab(store: WorkspaceStore, view: View, shown: boolean, visible: boolean) {
    const pane = store.app.views.rendererFor(view)?.pane;
    if (!pane) {
      return html`
        <div class="flex h-full items-center justify-center px-6 text-center">
          <div class="max-w-md">
            <h2 class="mb-2 text-lg font-medium text-zinc-400">Page unavailable</h2>
            <p class="text-sm text-zinc-500">Nothing shows “${view.view}” pages now. The page opens here once the extension that shows it is loaded.</p>
          </div>
        </div>
      `;
    }
    return html`<reins-view-mount ?data-main-shown=${shown} class="block h-full min-h-0 min-w-0" .presentation=${pane} .view=${view} .context=${this.contextFor(store.source, "main")} .visible=${visible}></reins-view-mount>`;
  }

  /**
   * The main area: a column for each tab, each a page on a phone with a toolbar of its own that travels with it in a
   * swipe; on a wide screen all in the center column, the shown tab's visible, under one toolbar, which stays as
   * tabs change, so its highlight moves to the tab shown. A view alone without a toolbar of its own fills its column
   * there, with none.
   */
  private renderMain(store: WorkspaceStore, tabs: readonly View[]) {
    if (tabs.length === 0) {
      return html`<section class="col-start-2 row-start-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-2 md:row-start-2">${this.renderEmptyState()}</section>`;
    }
    const mobile = this.viewport.isMobileLayout;
    const shownTab = this.shownTab();
    const shownIndex = tabs.findIndex((tab) => tab.view === shownTab);
    const fills = tabs.length === 1 && store.app.views.rendererFor(tabs[0]!)?.pane?.toolbar == null;
    const desktopToolbar = !mobile && !fills && shownIndex >= 0
      ? html`<div class="z-20 col-start-2 row-start-1 min-w-0 overflow-hidden">${this.renderMainToolbar(store, tabs, shownIndex)}</div>`
      : nothing;
    // Keyed by name, so a tab keeps its mounted view while the tabs around it change.
    const columns = tabs.map((tab, index) => {
      const shown = index === shownIndex;
      const visible = shown && (!mobile || this.activePane === "main");
      const column = `--column: ${index + 2};`;
      return keyed(tab.view, html`
        ${mobile ? html`<div class="z-20 row-start-1 min-w-0 overflow-hidden [grid-column:var(--column)]" style=${column}>${this.renderMainToolbar(store, tabs, index)}</div>` : nothing}
        <section class="row-start-2 h-full min-h-0 min-w-0 overflow-hidden [grid-column:var(--column)] md:[grid-column:2] ${fills ? "md:row-start-1 md:row-span-2" : "md:row-start-2"} ${shown ? "" : "md:hidden"}" style=${column}>
          ${this.renderTab(store, tab, shown, visible)}
        </section>
      `);
    });
    return html`${desktopToolbar}${columns}`;
  }

  private renderInspector(store: WorkspaceStore, swipeX: number | null) {
    const inspector = store.inspector;
    return html`
      <app-inspector
        class="block h-full min-h-0"
        .tabs=${inspector.tabs}
        .activeKey=${inspector.activeTab.key}
        .swipeX=${swipeX}
        .views=${store.app.views}
        .context=${this.contextFor(store.source, "inspector")}
        @inspector-tab-focus=${(event: CustomEvent<string>) => inspector.focus(event.detail)}
        @inspector-tab-close=${(event: CustomEvent<string>) => inspector.close(event.detail)}
        @file-select=${(event: CustomEvent<string>) => this.handleFileSelect(event)}
      ></app-inspector>
    `;
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
    this.pageSwipe.syncPage();
    const tabs = this.mainTabs();
    const pages = this.pages();
    const offsets = pages.offsets(pages.pageOf(this.activePane), this.pageSwipe.translateX, this.pageSwipe.viewportWidth);
    const hasProject = store.projectId != null;
    const gridStyle = `grid-template-columns: repeat(${pages.columns}, 100%); transform: translate3d(${offsets.surface}, 0, 0);`;
    const width = this.workspaceWidth();
    const shown = store.inspector.activeTab.view;
    this.layout.showInspectorView(shown.view, store.app.views.rendererFor(shown)?.pane?.width);
    const left = this.layout.width("sessions", width);
    const right = hasProject ? this.layout.width("inspector", width) : 0;
    const desktopColumns = `md:![grid-template-columns:var(--workspace-left)_minmax(0,1fr)_var(--workspace-right)]`; 

    return html`
      <div
        class="relative h-full min-h-0 min-w-0 overflow-clip swipe-shell"
        data-workspace-shell
        ?data-resizing=${this.resizePointer != null}
        @click=${this.pageSwipe.clickCaptureHandler}
        @pointerdown=${this.pageSwipe.handlePointerDown}
        @pointermove=${this.pageSwipe.handlePointerMove}
        @pointerup=${this.pageSwipe.handlePointerEnd}
        @pointercancel=${this.pageSwipe.handlePointerCancel}
      >
        ${this.renderHandle("sessions")}
        ${hasProject ? this.renderHandle("inspector") : nothing}
        <div
          class="workspace-surface grid h-full min-h-0 min-w-0 grid-rows-[50px_minmax(0,1fr)] md:!transform-none ${desktopColumns} md:grid-rows-[50px_minmax(0,1fr)]"
          data-dragging=${this.pageSwipe.dragging || this.pageSwipe.settling ? "true" : "false"}
          style=${`${gridStyle} --workspace-left: ${left}px; --workspace-right: ${right}px;`}
        >
          <section class="col-start-1 row-start-1 row-span-2 h-full min-h-0 min-w-0 overflow-hidden md:col-start-1 md:row-start-1 md:row-span-2">${this.renderSessionSidebar(store)}</section>
          ${this.renderMain(store, tabs)}
          <section class="row-start-1 row-span-2 h-full min-h-0 min-w-0 overflow-hidden [grid-column:var(--inspector-column)] md:col-start-3 md:row-start-1 md:row-span-2 ${hasProject ? "md:border-l md:border-zinc-700" : ""}" style=${`--inspector-column: ${pages.columns};`}>${hasProject ? this.renderInspector(store, offsets.inspector) : nothing}</section>
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
