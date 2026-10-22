/** Root application shell: lifecycle, route outlet, and global overlays. */

import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { AppRouteController } from "../controllers/app-route-controller.js";
import { registerFileReferences } from "../models/file-references.js";
import { AppStore } from "../models/stores/app-store.js";
import { registerFileBrowser } from "../models/stores/file-browser-store.js";
import { QuickOpenStore } from "../models/stores/quick-open-store.js";
import { ReinsHost } from "../reins-sdk/host.js";
import { AppClient } from "../models/ws-client.js";
import { openSettings, renderRoutePage } from "../routing/app-router.js";
import type { Route } from "../routing/router.js";
import type { SourceDetail, OpenImageViewerDetail, OpenInBrowserDetail } from "./events.js";
import type { ImageLightbox } from "./image-lightbox.js";
import type { QuickOpen } from "./quick-open.js";
import { registerFileView } from "./file-view/file-view.js";
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
  // The composition root of the Reins SDK: built-in features get it here, at startup, and nowhere else.
  private host = new ReinsHost(this.appStore.files);
  private fileBrowserStore = registerFileBrowser(this.host.sdk);
  private disposeFeatures = [registerFileView(this.host.sdk), registerFileReferences(this.host.sdk)];
  private quickOpenStore = new QuickOpenStore(this.appStore.sessionCache);
  private unsubscribeStore: (() => void) | null = null;
  private routes = new AppRouteController(this, {
    onRouteChange: (route) => this.handleRouteChange(route),
  });

  @state() private currentRoute: Route = { name: "empty", params: {} };
  @state() private storeVersion = 0;
  @query("quick-open") private quickOpen!: QuickOpen;
  @query("image-lightbox") private imageLightbox!: ImageLightbox;

  override connectedCallback() {
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
    this.fileBrowserStore.dispose();
    for (const dispose of this.disposeFeatures) dispose();
    this.host.dispose();
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
    const { source, path, startLine, endLine, mode } = event.detail;
    this.fileBrowserStore.open(source, { path, startLine, endLine, mode });
  };

  private handleOpenImageViewer = (event: CustomEvent<OpenImageViewerDetail>) => {
    this.imageLightbox?.show(event.detail);
  };

  override render() {
    void this.storeVersion;
    const store = this.appStore;
    const mainContent = renderRoutePage(this.currentRoute, { app: store, host: this.host });

    return html`
      <div
        class="h-dvh w-full flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden"
        @open-quick-open=${() => this.quickOpen?.open()}
        @open-file-search=${(event: CustomEvent<SourceDetail>) => this.fileBrowserStore.openSearch(event.detail.source)}
        @open-file-browser=${(event: CustomEvent<SourceDetail>) => this.fileBrowserStore.open(event.detail.source)}
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
