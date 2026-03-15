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
import { AppClient } from "./ws-client.js";
import type { DiffPanel } from "./changes/diff-panel.js";
import { FileTreeState } from "./changes/file-tree-state.js";
import { AppStore } from "./stores/app-store.js";
import { parseHash } from "./router.js";
import type { Route } from "./router.js";

// Ensure sub-components are registered
import "./chat-panel.js";
import "./changes/diff-panel.js";
import "./changes/diff-file-tree.js";
import type { SessionSidebar } from "./session-sidebar.js";
import "./session-sidebar.js";
import "./branch-indicator.js";
import "./quick-open.js";
import type { QuickOpen } from "./quick-open.js";
import { QuickOpenStore } from "./stores/quick-open-store.js";

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
    || (navigator as any).standalone === true;
  private quickOpenStore = new QuickOpenStore();
  @query("quick-open") private _quickOpen!: QuickOpen;

  override connectedCallback() {
    super.connectedCallback();

    // Subscribe to app store changes (covers project store + activity)
    this._unsubscribeStore = this.appStore.subscribe(() => {
      this._storeVersion++;
      this.updateTitleAndFavicon();
    });

    // Apply initial route
    const route = parseHash();
    this.applyRoute(route);

    // Listen for hash changes
    window.addEventListener("hashchange", this.onHashChange);

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
    this.appStore.disconnect();
    this.appStore.dispose();
  }

  private onHashChange = () => {
    const previousProjectId = this.appStore.projectId;
    const route = parseHash();
    this.applyRoute(route, previousProjectId);
  };

  private async applyRoute(route: Route, previousProjectId?: number | null) {
    const store = this.appStore;
    const previousSessionId = store.sessionId;
    await store.setRoute(route.sessionId);
    // Reset file tree when project changes (derived from session)
    if (previousProjectId !== undefined && store.projectId !== previousProjectId) {
      this.fileTreeState.reset();
    }
    // When switching sessions, jump to chat and refresh the diff
    if (store.sessionId && store.sessionId !== previousSessionId) {
      this.activeTab = "chat";
      store.diffStore.refresh();
    }
    // Clear activity notification when viewing a session
    if (store.sessionData) {
      store.clearActivity(store.sessionData.id);
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

  private handleRefreshDiff() {
    this.appStore.diffStore.refresh();
    this.appStore.diffStore.fetchFullDiff();
  }

  private getDiffPanel(): DiffPanel | null {
    return this.querySelector("diff-panel") as DiffPanel | null;
  }

  /**
   * Handle file-select from the chat-tab file tree:
   * switch to the Changes tab, then scroll to that file's diff card.
   */
  private handleChatFileSelect(e: Event) {
    const path = (e as CustomEvent<string>).detail;
    this.activeTab = "changes";
    requestAnimationFrame(() => {
      this.getDiffPanel()?.scrollToFile(path);
    });
  }

  private openSidebar() {
    const sidebar = this.querySelector("session-sidebar") as SessionSidebar | null;
    sidebar?.open();
  }

  private openQuickOpen() {
    this._quickOpen?.open();
  }

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
    const hasProject = store.projectId != null;

    return html`
      <div class="h-dvh w-full flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden">
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
            .activityMap=${store.activityMap}
          ></session-sidebar>

          ${hasProject ? html`
            <div class="flex-1 flex flex-col min-w-0">
              <!-- Tab bar -->
              <div class="flex items-center border-b border-zinc-700 bg-zinc-800/50 overflow-x-auto">
                <!-- Hamburger menu (mobile only) -->
                <button
                  class="p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer md:hidden shrink-0"
                  @click=${this.openSidebar}
                  title="Open sidebar"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </button>
                <!-- Search button (mobile only) -->
                <button
                  class="p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
                  @click=${this.openQuickOpen}
                  title="Search sessions (Cmd+K)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2h10"/><path d="M5 6h14"/><rect x="3" y="10" width="18" height="12" rx="2"/></svg>
                </button>
                <branch-indicator
                  .currentBranch=${this.appStore.diffStore.branch ?? this.appStore.diffStore.fileData.branch}
                ></branch-indicator>
                <button
                  class="px-4 py-2 text-sm font-semibold transition-colors cursor-pointer shrink-0 ${this.activeTab === "chat" ? "text-zinc-100 border-b-2 border-blue-500" : "text-zinc-500 hover:text-zinc-300"}"
                  @click=${() => this.activeTab = "chat"}
                >
                  Chat
                </button>
                <button
                  class="px-4 py-2 text-sm font-semibold transition-colors cursor-pointer shrink-0 ${this.activeTab === "changes" ? "text-zinc-100 border-b-2 border-blue-500" : "text-zinc-500 hover:text-zinc-300"}"
                  @click=${() => this.activeTab = "changes"}
                >
                  Changes
                </button>
                <div class="flex-1"></div>
                <div class="flex items-center gap-2 px-4 shrink-0">
                  ${this.activeTab === "changes" ? html`
                    <button
                      class="text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                      @click=${this.handleRefreshDiff}
                      title="Refresh diff"
                    >
                      Refresh
                    </button>
                  ` : ""}
                  ${this.isStandalone ? html`
                    <button
                      class="p-1 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
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
                <chat-panel
                  class="flex-1 min-h-0 min-w-0"
                  .client=${this.appStore.client}
                  .sessionId=${store.sessionId}
                  .sessionData=${store.sessionData}
                ></chat-panel>
                <!-- File tree sidebar (chat tab, wide screens only) -->
                <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
                  <diff-file-tree
                    .store=${this.appStore.diffStore}
                    .treeState=${this.fileTreeState}
                    @file-select=${this.handleChatFileSelect}
                  ></diff-file-tree>
                </div>
              </div>
              ${keyed(store.projectId, html`<diff-panel
                class="flex-1 min-h-0 ${this.activeTab === "changes" ? "" : "hidden"}"
                .store=${this.appStore.diffStore}
                .treeState=${this.fileTreeState}
                .visible=${this.activeTab === "changes"}
              ></diff-panel>`)}
            </div>
          ` : this.renderEmptyState()}
        </div>

        <!-- Quick-open overlay -->
        <quick-open
          .activityMap=${this.appStore.activityMap}
          .store=${this.quickOpenStore}
        ></quick-open>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
