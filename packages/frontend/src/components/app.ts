/**
 * App Shell — thin root component.
 *
 * Creates the AppStore and WebSocket client, applies hash-based routes,
 * and renders views. All server communication and event handling lives
 * in AppStore — this component only owns UI-local concerns (active tab,
 * file tree state, document title).
 *
 * Routes:
 *  - `#/session/:sessionId` — view a specific session
 *  - (empty hash)           — no project selected, show empty state
 */

import { LitElement, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, state, query } from "lit/decorators.js";
import { AppClient } from "../models/ws-client.js";
import type { DiffPanel } from "./changes/diff-panel.js";
import { FileTreeState } from "../models/changes/file-tree-state.js";
import { AppStore } from "../models/stores/app-store.js";
import { parseHash, getLastHash, saveHash } from "../models/router.js";
import type { Route } from "../models/router.js";

// Ensure sub-components are registered
import "./chat-panel.js";
import "./changes/diff-panel.js";
import "./changes/diff-file-tree.js";
import "./session-sidebar.js";
import "./branch-indicator.js";
import "./nav-icon.js";
import "./quick-open.js";
import type { QuickOpen } from "./quick-open.js";
import { QuickOpenStore } from "../models/stores/quick-open-store.js";
import "./file-search.js";
import type { FileSearch } from "./file-search.js";
import "./file-viewer/file-browser.js";
import type { FileBrowser } from "./file-viewer/file-browser.js";
import { FileBrowserStore } from "../models/stores/file-browser-store.js";
import type { OpenImageViewerDetail, OpenInBrowserDetail } from "./events.js";
import { setProjectDir, toRelativePath } from "../models/path-utils.js";
import "./image-lightbox.js";
import type { ImageLightbox } from "./image-lightbox.js";
import "./settings/panel.js";
import type { SettingsPanel } from "./settings/panel.js";

@customElement("app-shell")
export class AppShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private appStore = new AppStore(new AppClient());
  private fileTreeState = new FileTreeState();
  private _unsubscribeStore: (() => void) | null = null;

  @state() private activeTab: "chat" | "changes" = "chat";
  /** Bumped on every store notification to trigger a re-render. */
  @state() private _storeVersion = 0;
  private isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || ("standalone" in navigator && navigator.standalone === true);
  private quickOpenStore = new QuickOpenStore();
  @query("quick-open") private _quickOpen!: QuickOpen;
  private fileBrowserStore = new FileBrowserStore();
  @query("file-search") private _fileSearch!: FileSearch;
  @query("file-browser") private _fileBrowser!: FileBrowser;
  @query("image-lightbox") private _imageLightbox!: ImageLightbox;
  @query("settings-panel") private _settingsPanel!: SettingsPanel;

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

    // Apply initial route — restore last-viewed hash on fresh page loads
    const route = parseHash();
    if (!route.sessionId) {
      const lastHash = getLastHash();
      if (lastHash) {
        // Replace so we don't push an empty-hash entry into history
        history.replaceState(null, "", lastHash);
        this.applyRoute(parseHash());
      } else {
        this.applyRoute(route);
      }
    } else {
      this.applyRoute(route);
    }

    // Listen for hash changes
    window.addEventListener("hashchange", this.onHashChange);

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

    // Detect virtual keyboard open/close to toggle safe-area bottom padding.
    // Capture the initial viewport height before any keyboard appears —
    // on iOS standalone/PWA mode, both visualViewport.height and
    // window.innerHeight shrink together, so we need a fixed reference.
    const vv = window.visualViewport;
    if (vv) {
      const initialHeight = vv.height;
      vv.addEventListener("resize", () => {
        const keyboardOpen = vv.height < initialHeight * 0.75;
        document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
      });
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeStore?.();
    window.removeEventListener("hashchange", this.onHashChange);
    document.removeEventListener("open-in-browser", this.handleOpenInBrowser);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.appStore.disconnect();
    this.appStore.dispose();
  }

  private onHashChange = () => {
    saveHash(location.hash);
    const previousProjectId = this.appStore.projectId;
    const route = parseHash();
    this.applyRoute(route, previousProjectId);
  };

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

  private async applyRoute(route: Route, previousProjectId?: number | null) {
    const store = this.appStore;
    const previousSessionId = store.sessionId;
    const nextSessionId = route.sessionId ?? "";

    // Show the chat shell immediately; session metadata and messages hydrate
    // through the active store subscription.
    if (nextSessionId && nextSessionId !== previousSessionId) {
      this.activeTab = "chat";
    }

    await store.setRoute(route.sessionId);
    // Reset file tree when project changes (derived from session)
    if (previousProjectId !== undefined && store.projectId !== previousProjectId) {
      this.fileTreeState.reset();
    }
    // Track session visit for quick-open recency ordering
    if (store.sessionId) {
      this.quickOpenStore.recordVisit(store.sessionId);
    }
  }

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

  private getDiffPanel(): DiffPanel | null {
    return this.querySelector("diff-panel");
  }

  /**
   * Handle file-select from the chat-tab file tree:
   * switch to the Changes tab, then scroll to that file's diff card.
   */
  private handleChatFileSelect(e: CustomEvent<string>) {
    const path = e.detail;
    this.activeTab = "changes";
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

  private openSidebar() {
    this.querySelector("session-sidebar")?.open();
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

  private renderEmptyState() {
    return html`
      <div class="flex-1 flex flex-col">
        <!-- Mobile hamburger for empty state -->
        <div class="flex items-center p-2 border-b border-zinc-700 bg-zinc-800/50 md:hidden">
          <button
            class="p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
            @click=${this.openSidebar}
            title="Open sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <button
            class="p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
            @click=${this.openQuickOpen}
            title="Search sessions (Cmd+K)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2h10"/><path d="M5 6h14"/><rect x="3" y="10" width="18" height="12" rx="2"/></svg>
          </button>
          ${this.isStandalone ? html`
            <div class="flex-1"></div>
            <button
              class="p-2 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
              @click=${() => location.reload()}
              title="Reload"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
            </button>
          ` : ""}
        </div>
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

        <!-- Main layout: sidebar + content -->
        <div class="flex-1 flex min-h-0 min-w-0 overflow-hidden">
          <!-- Session sidebar -->
          <session-sidebar
            .store=${store}
          ></session-sidebar>

          ${hasProject ? html`
            <div class="flex-1 flex flex-col min-w-0">
              <!-- Tab bar -->
              <div class="h-[50px] flex items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/80 px-2 py-1.5 overflow-hidden shrink-0">
                <!-- Hamburger menu (mobile only) -->
                <button
                  class="p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer md:hidden shrink-0 transition-colors"
                  @click=${this.openSidebar}
                  title="Open sidebar"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </button>
                <!-- File browser button -->
                <nav-icon icon="folder" label="Browse files" .size=${18}
                  @click=${() => this._fileBrowser?.open()}></nav-icon>
                <div class="relative grid grid-cols-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-1 shrink-0 overflow-hidden">
                  <span
                    class="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-blue-500/20 shadow-sm transition-transform duration-200 ease-out will-change-transform ${this.activeTab === "changes" ? "translate-x-full" : "translate-x-0"}"
                    aria-hidden="true"
                  ></span>
                  <button
                    class="relative z-10 px-3 py-1 rounded-md text-sm font-semibold transition-colors duration-200 cursor-pointer shrink-0 ${this.activeTab === "chat" ? "text-blue-100" : "text-zinc-500 hover:text-zinc-300"}"
                    aria-pressed=${this.activeTab === "chat"}
                    @click=${() => this.activeTab = "chat"}
                  >
                    Chat
                  </button>
                  <button
                    class="relative z-10 px-3 py-1 rounded-md text-sm font-semibold transition-colors duration-200 cursor-pointer shrink-0 ${this.activeTab === "changes" ? "text-blue-100" : "text-zinc-500 hover:text-zinc-300"}"
                    aria-pressed=${this.activeTab === "changes"}
                    @click=${() => this.activeTab = "changes"}
                  >
                    Changes
                  </button>
                </div>
                <div class="min-w-0 flex-1 overflow-hidden flex justify-end">
                  <branch-indicator
                    class="block min-w-0 max-w-full"
                    .currentBranch=${store.diffStore.branch ?? store.diffStore.fileData.branch}
                  ></branch-indicator>
                </div>
                <div class="flex items-center gap-1 pr-1 shrink-0">
                  ${this.isStandalone ? html`
                    <button
                      class="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 transition-colors cursor-pointer"
                      @click=${() => location.reload()}
                      title="Reload"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                    </button>
                  ` : ""}
                  ${store.connected
                    ? html`<span class="w-2 h-2 rounded-full bg-green-500" title="Connected"></span>`
                    : html`<span class="w-2 h-2 rounded-full bg-red-500" title="Disconnected"></span>`
                  }
                </div>
              </div>

              <!-- Tab content -->
              <div class="flex-1 flex min-h-0 ${this.activeTab === "chat" ? "" : "hidden"}">
                ${keyed(store.sessionId, html`<chat-panel
                  class="flex-1 min-h-0 min-w-0"
                  .store=${activeSessionStore}
                  .projectStore=${store.activeProjectStore}
                  ?visible=${this.activeTab === "chat"}
                ></chat-panel>`)}
                <!-- File tree sidebar (chat tab, wide screens only) -->
                <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
                  <diff-file-tree
                    .store=${store.diffStore}
                    .treeState=${this.fileTreeState}
                    @file-select=${this.handleChatFileSelect}
                  ></diff-file-tree>
                </div>
              </div>
              ${keyed(store.projectId, html`<diff-panel
                class="flex-1 min-h-0 ${this.activeTab === "changes" ? "" : "hidden"}"
                .store=${store.diffStore}
                .treeState=${this.fileTreeState}
                .visible=${this.activeTab === "changes"}
              ></diff-panel>`)}
            </div>
          ` : this.renderEmptyState()}
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
        <settings-panel></settings-panel>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
