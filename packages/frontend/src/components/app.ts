/** Root application shell: lifecycle, route outlet, and global overlays. */

import { LitElement, html, type PropertyValues } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { AppRouteController } from "../controllers/app-route-controller.js";
import { BUILT_IN_EXTENSIONS } from "../extensions/built-in.js";
import { api } from "../models/api.js";
import { AppStore } from "../models/stores/app-store.js";
import { FileBrowserStore } from "../models/stores/file-browser-store.js";
import { QuickOpenStore } from "../models/stores/quick-open-store.js";
import { createReinsSdk, type SdkHost } from "../sdk-host/create-sdk.js";
import { SdkSessions } from "../sdk-host/sessions.js";
import { SdkUi } from "../sdk-host/ui.js";
import { SdkNodes, SdkProjects, SdkTasks } from "../sdk-host/projects.js";
import { AppClient } from "../models/ws-client.js";
import { mainViewOf, openSettings, renderRoutePage } from "../routing/app-router.js";
import { RoutedMainArea } from "../routing/main-area.js";
import type { Route } from "../routing/router.js";
import type { View } from "@reins/sdk";
import type { SourceDetail, OpenImageViewerDetail, OpenInBrowserDetail } from "./events.js";
import type { AppWorkspace } from "./app-workspace.js";
import type { ImageLightbox } from "./image-lightbox.js";
import { registerNewSessionPage } from "./new-session-page.js";
import { registerDiffFileTree } from "./changes/diff-file-tree.js";
import { openFilesOfShownSession } from "./open-file-requests.js";
import { registerSessionViews } from "./session-views.js";
import type { QuickOpen } from "./quick-open.js";
import "./file-browser/file-browser.js";
import "./file-browser/file-search.js";
import "./image-lightbox.js";
import "./quick-open.js";

@customElement("app-shell")
export class AppShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private appStore = new AppStore(new AppClient());
  /** The main area is the workspace routes' page, which knows what the view it shows is about. */
  private mainArea = new RoutedMainArea(this.appStore.views, () => this.workspace);
  /** What each extension's SDK is built over. */
  private sdkSessions = new SdkSessions(this.appStore);
  private sdkHost: SdkHost = {
    app: this.appStore,
    sessions: this.sdkSessions,
    ui: new SdkUi(this.appStore.sessionCache, this.sdkSessions),
    projects: new SdkProjects(this.appStore.projectsStore),
    tasks: new SdkTasks(this.appStore.projectsStore),
    nodes: new SdkNodes(this.appStore.projectsStore),
    containers: { inspector: this.appStore.inspector, main: this.mainArea },
    http: api,
    socket: this.appStore.client,
  };
  private disposeSdk: Array<() => void> = [];
  private fileBrowserStore: FileBrowserStore | null = null;
  private quickOpenStore = new QuickOpenStore(this.appStore.sessionCache);
  private unsubscribeStore: (() => void) | null = null;
  private routes = new AppRouteController(this, {
    onRouteChange: (route) => this.handleRouteChange(route),
  });

  @state() private currentRoute: Route = { name: "empty", params: {} };
  @state() private storeVersion = 0;
  @query("quick-open") private quickOpen!: QuickOpen;
  /** The workspace routes' page: the main area's view, when it shows one. */
  @query("app-workspace") private workspace!: AppWorkspace | null;
  @query("image-lightbox") private imageLightbox!: ImageLightbox;

  override connectedCallback() {
    // The app's own views follow the main area through the SDK's workspace, as an extension would.
    const { workspace } = createReinsSdk({ name: "app", label: "Reins" }, this.sdkHost);
    this.disposeSdk = [
      registerSessionViews(this.appStore.views, this.appStore),
      registerNewSessionPage(this.appStore.views, this.appStore),
      registerDiffFileTree(this.appStore.views, workspace, this.appStore.diffs),
      openFilesOfShownSession(this.appStore.client, workspace, document),
      ...BUILT_IN_EXTENSIONS.map((extension) => this.appStore.extensions.activate(extension, createReinsSdk(extension, this.sdkHost))),
      // A page registered or gone changes the title of the page shown.
      this.appStore.views.subscribe(() => this.updateDocumentTitle()),
    ];
    // The file browser is app-shell's own overlay, not a registered extension, but it uses only the SDK.
    this.fileBrowserStore = new FileBrowserStore(createReinsSdk({ name: "file-browser", label: "File browser" }, this.sdkHost));
    super.connectedCallback();
    this.unsubscribeStore = this.appStore.subscribe(() => {
      this.storeVersion += 1;
      this.updateDocumentTitle();
    });
    this.routes.connect();
    // The server's `open_file` is dispatched on the document, outside any component.
    document.addEventListener("open-in-browser", this.handleOpenInBrowser);
    this.appStore.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeStore?.();
    document.removeEventListener("open-in-browser", this.handleOpenInBrowser);
    this.appStore.disconnect();
    this.quickOpenStore.dispose();
    this.fileBrowserStore?.dispose();
    this.fileBrowserStore = null;
    for (const dispose of this.disposeSdk) dispose();
    this.disposeSdk = [];
    this.appStore.dispose();
  }

  /**
   * The title of the view the main area shows alone, if any, after the activity across sessions. A tab's title
   * names the tab, not the page, so a session's Chat and Changes leave it out.
   */
  private updateDocumentTitle(): void {
    const { running, finished } = this.appStore.activitySummary;
    const view = mainViewOf(this.currentRoute);
    const alone = view && !this.appStore.views.rendererFor(view)?.tabOf;
    const context = this.workspace?.mainContext();
    const page = alone && context ? this.appStore.views.titleOf(view, context) : null;
    const name = page ? `${page} · REINS` : "REINS";
    if (running > 0) document.title = `(${running} running) ${name}`;
    else if (finished > 0) document.title = `(${finished} new) ${name}`;
    else document.title = name;
  }

  private handleRouteChange(route: Route): void {
    this.currentRoute = route;
    if ((route.name === "session" || route.name === "session-changes") && route.params.sessionId) {
      this.quickOpenStore.recordVisit(route.params.sessionId);
    }
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("currentRoute")) this.updateDocumentTitle();
    this.mainArea.changed();
  }

  private handleOpenInBrowser = (event: CustomEvent<OpenInBrowserDetail>) => {
    const { source, path, startLine, endLine, mode } = event.detail;
    this.fileBrowserStore?.open(source, { path, startLine, endLine, mode });
  };

  private handleOpenImageViewer = (event: CustomEvent<OpenImageViewerDetail>) => {
    this.imageLightbox?.show(event.detail);
  };

  override render() {
    void this.storeVersion;
    const store = this.appStore;
    const mainContent = renderRoutePage(this.currentRoute, { app: store });

    return html`
      <div
        class="h-dvh w-full flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden"
        @open-quick-open=${() => this.quickOpen?.open()}
        @open-file-search=${(event: CustomEvent<SourceDetail>) => this.fileBrowserStore?.openSearch(event.detail.source)}
        @open-file-browser=${(event: CustomEvent<SourceDetail>) => this.fileBrowserStore?.open(event.detail.source)}
        @open-image-viewer=${this.handleOpenImageViewer}
        @open-settings=${() => openSettings()}
        @main-view-change=${() => this.mainArea.changed()}
        @open-main-view=${(event: CustomEvent<View>) => this.mainArea.open(event.detail)}
      >
        ${!store.connected ? html`
          <div class="bg-yellow-800 text-yellow-200 text-xs text-center py-1">
            Connecting to server...
          </div>
        ` : ""}

        <div class="flex-1 min-h-0 min-w-0 overflow-hidden">${mainContent}</div>

        <quick-open .store=${this.quickOpenStore}></quick-open>
        <file-search .store=${this.fileBrowserStore}></file-search>
        <file-browser .store=${this.fileBrowserStore}></file-browser>
        <image-lightbox></image-lightbox>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
