/** Root application shell: lifecycle, route outlet, and global overlays. */

import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { AppRouteController } from "../controllers/app-route-controller.js";
import { AppStore } from "../models/stores/app-store.js";
import { FileBrowserStore } from "../models/stores/file-browser-store.js";
import { QuickOpenStore } from "../models/stores/quick-open-store.js";
import { AppClient } from "../models/ws-client.js";
import { openSettings, renderRoutePage } from "../routing/app-router.js";
import type { Route } from "../routing/router.js";
import type {
  OpenImageViewerDetail,
  OpenInBrowserDetail,
  ProjectScopeDetail,
} from "./events.js";
import type { FileSearch } from "./file-search.js";
import type { FileBrowser } from "./file-viewer/file-browser.js";
import type { ImageLightbox } from "./image-lightbox.js";
import type { QuickOpen } from "./quick-open.js";
import "./file-search.js";
import "./file-viewer/file-browser.js";
import "./image-lightbox.js";
import "./quick-open.js";

@customElement("app-shell")
export class AppShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private appStore = new AppStore(new AppClient());
  private quickOpenStore = new QuickOpenStore(this.appStore.sessionCache);
  private fileBrowserStore = new FileBrowserStore();
  private unsubscribeStore: (() => void) | null = null;
  private routes = new AppRouteController(this, {
    onRouteChange: (route) => this.handleRouteChange(route),
  });

  @state() private currentRoute: Route = { name: "empty", params: {} };
  @state() private storeVersion = 0;
  @query("quick-open") private quickOpen!: QuickOpen;
  @query("file-search") private fileSearch!: FileSearch;
  @query("file-browser") private fileBrowser!: FileBrowser;
  @query("image-lightbox") private imageLightbox!: ImageLightbox;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribeStore = this.appStore.subscribe(() => {
      this.storeVersion += 1;
      this.updateDocumentTitle();
    });
    this.routes.connect();
    document.addEventListener("open-in-browser", this.handleOpenInBrowser);
    this.appStore.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeStore?.();
    document.removeEventListener("open-in-browser", this.handleOpenInBrowser);
    this.appStore.disconnect();
    this.quickOpenStore.dispose();
    this.appStore.dispose();
  }

  private updateDocumentTitle(): void {
    const { running, finished } = this.appStore.activitySummary;
    if (running > 0) document.title = `(${running} running) REINS`;
    else if (finished > 0) document.title = `(${finished} new) REINS`;
    else document.title = "REINS";
  }

  private handleRouteChange(route: Route): void {
    this.currentRoute = route;
    if (route.name === "session" && route.params.sessionId) {
      this.quickOpenStore.recordVisit(route.params.sessionId);
    }
  }

  private handleOpenInBrowser = (event: CustomEvent<OpenInBrowserDetail>) => {
    const { projectId, path, startLine, endLine, viewMode } = event.detail;
    if (!path) return;
    this.fileBrowser?.openFile(
      projectId,
      path,
      startLine != null && endLine != null ? { startLine, endLine } : undefined,
      viewMode,
    );
  };

  private handleOpenImageViewer = (event: CustomEvent<OpenImageViewerDetail>) => {
    this.imageLightbox?.show(event.detail);
  };

  private handleOpenFileSearch = (event: CustomEvent<ProjectScopeDetail>) => {
    this.fileSearch?.open(event.detail.projectId);
  };

  private handleOpenFileBrowser = (event: CustomEvent<ProjectScopeDetail>) => {
    this.fileBrowser?.open(event.detail.projectId);
  };

  override render() {
    void this.storeVersion;
    const store = this.appStore;
    const mainContent = renderRoutePage(this.currentRoute, { app: store });

    return html`
      <div
        class="h-dvh w-full flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden"
        @open-quick-open=${() => this.quickOpen?.open()}
        @open-file-search=${this.handleOpenFileSearch}
        @open-file-browser=${this.handleOpenFileBrowser}
        @open-image-viewer=${this.handleOpenImageViewer}
        @open-settings=${() => openSettings()}
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
