/**
 * App Shell
 *
 * Root component with session sidebar, chat panel, and diff panel.
 * Initializes shared stores, the WebSocket client, and wires everything
 * together. Uses light DOM for Tailwind compatibility.
 *
 * Routing: hash-based
 *  - `#/project/:id`                    — view project, resolves to most recent session
 *  - `#/project/:id/session/:sessionId` — view a specific session
 *  - (empty hash)                       — no project selected, show empty state
 */

import { LitElement, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, state } from "lit/decorators.js";
import { AppClient } from "./ws-client.js";
import type { DiffPanel } from "./changes/diff-panel.js";
import { DiffStore } from "./changes/diff-store.js";
import { FileTreeState } from "./changes/file-tree-state.js";
import { ActivityTracker } from "./activity-tracker.js";
import { ProjectStore } from "./project-store.js";
import { parseHash, navigateToSession } from "./router.js";
import type { Route } from "./router.js";

// Ensure sub-components are registered
import "./chat-panel.js";
import "./changes/diff-panel.js";
import "./changes/diff-file-tree.js";
import "./session-sidebar.js";
import "./branch-indicator.js";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

@customElement("app-shell")
export class AppShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private client = new AppClient();
  private projectStore = new ProjectStore();
  private diffStore = new DiffStore();
  private fileTreeState = new FileTreeState();
  private activityTracker = new ActivityTracker();
  private _unsubscribeStore: (() => void) | null = null;

  @state() private connected = false;
  @state() private activeTab: "chat" | "changes" = "chat";
  @state() private activityMap = new Map<string, import("./activity-tracker.js").ActivityState>();
  /** Bumped on every store notification to trigger a re-render. */
  @state() private _storeVersion = 0;

  override connectedCallback() {
    super.connectedCallback();

    // Subscribe to project store changes
    this._unsubscribeStore = this.projectStore.subscribe(() => {
      this._storeVersion++;
    });

    // Apply initial route
    const route = parseHash();
    this.diffStore.setProject(route.projectId);
    this.applyRoute(route);

    // Listen for hash changes
    window.addEventListener("hashchange", this.onHashChange);

    this.client.onConnection((connected) => {
      this.connected = connected;
      // On reconnect, re-fetch the active session to catch up on missed events
      if (connected && this.projectStore.sessionId) {
        this.projectStore.refreshSession();
      }
    });

    // Track session activity and refresh diff panel
    this.client.onEvent((sessionId, event) => {
      const store = this.projectStore;
      // Track activity for all sessions
      if (sessionId && event.type === "agent_start") {
        this.activityTracker.setRunning(sessionId);
      } else if (sessionId && event.type === "agent_end") {
        this.activityTracker.setFinished(sessionId, store.sessionId);
        setTimeout(() => store.refreshLists(), 500);
      }

      // Only refresh diff for the session we're viewing
      if (sessionId !== store.sessionId) return;

      const refreshDiff =
        (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName)) ||
        event.type === "agent_end";

      if (refreshDiff) {
        setTimeout(() => this.diffStore.refresh(), 500);
      }
    });

    // React to activity state changes (favicon, title)
    this.activityTracker.onChange(() => {
      this.activityMap = this.activityTracker.getAll();
      this.updateTitleAndFavicon();
    });

    this.client.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeStore?.();
    window.removeEventListener("hashchange", this.onHashChange);
    this.client.disconnect();
    this.diffStore.dispose();
  }

  private onHashChange = () => {
    const route = parseHash();
    if (route.projectId !== this.projectStore.projectId) {
      this.diffStore.setProject(route.projectId);
      this.fileTreeState.reset();
    }
    this.applyRoute(route);
  };

  private async applyRoute(route: Route) {
    const result = await this.projectStore.setRoute(route.projectId, route.sessionId);
    if (result?.navigateTo && route.projectId != null) {
      navigateToSession(route.projectId, result.navigateTo, true);
    }
    // Clear activity notification when viewing a session
    if (this.projectStore.sessionData) {
      this.activityTracker.clear(this.projectStore.sessionData.id);
    }
  }

  private updateTitleAndFavicon(): void {
    const { running, finished } = this.activityTracker.summary;

    if (running > 0) {
      document.title = `(${running} running) REINS`;
    } else if (finished > 0) {
      document.title = `(${finished} new) REINS`;
    } else {
      document.title = "REINS";
    }
  }

  private handleRefreshDiff() {
    this.diffStore.refresh();
    this.diffStore.fetchFullDiff();
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

  private renderEmptyState() {
    return html`
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
    `;
  }

  override render() {
    // Read from store (the _storeVersion state ensures re-renders on changes)
    void this._storeVersion;
    const store = this.projectStore;
    const hasProject = store.projectId != null;

    return html`
      <div class="h-dvh w-full flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden">
        <!-- Connection status bar -->
        ${!this.connected ? html`
          <div class="bg-yellow-800 text-yellow-200 text-xs text-center py-1">
            Connecting to server...
          </div>
        ` : ""}

        <!-- Main layout: sidebar + content -->
        <div class="flex-1 flex min-h-0 min-w-0 overflow-hidden">
          <!-- Session sidebar -->
          <session-sidebar
            .store=${store}
            .activityMap=${this.activityMap}
          ></session-sidebar>

          ${hasProject ? html`
            <div class="flex-1 flex flex-col min-w-0">
              <!-- Tab bar -->
              <div class="flex items-center border-b border-zinc-700 bg-zinc-800/50">
                <branch-indicator
                  .projectId=${store.projectId}
                  .taskId=${store.sessionData?.task_id ?? null}
                  .baseBranch=${this.diffStore.fileData.baseBranch}
                ></branch-indicator>
                <button
                  class="px-4 py-2 text-sm font-semibold transition-colors cursor-pointer ${this.activeTab === "chat" ? "text-zinc-100 border-b-2 border-blue-500" : "text-zinc-500 hover:text-zinc-300"}"
                  @click=${() => this.activeTab = "chat"}
                >
                  Chat
                </button>
                <button
                  class="px-4 py-2 text-sm font-semibold transition-colors cursor-pointer ${this.activeTab === "changes" ? "text-zinc-100 border-b-2 border-blue-500" : "text-zinc-500 hover:text-zinc-300"}"
                  @click=${() => this.activeTab = "changes"}
                >
                  Changes
                </button>
                <div class="flex-1"></div>
                <div class="flex items-center gap-2 px-4">
                  ${this.activeTab === "changes" ? html`
                    <button
                      class="text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                      @click=${this.handleRefreshDiff}
                      title="Refresh diff"
                    >
                      Refresh
                    </button>
                  ` : ""}
                  ${this.connected
                    ? html`<span class="w-2 h-2 rounded-full bg-green-500" title="Connected"></span>`
                    : html`<span class="w-2 h-2 rounded-full bg-red-500" title="Disconnected"></span>`
                  }
                </div>
              </div>

              <!-- Tab content -->
              <div class="flex-1 flex min-h-0 ${this.activeTab === "chat" ? "" : "hidden"}">
                <chat-panel
                  class="flex-1 min-h-0 min-w-0"
                  .client=${this.client}
                  .sessionId=${store.sessionId}
                  .sessionData=${store.sessionData}
                ></chat-panel>
                <!-- File tree sidebar (chat tab, wide screens only) -->
                <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
                  <diff-file-tree
                    .store=${this.diffStore}
                    .treeState=${this.fileTreeState}
                    @file-select=${this.handleChatFileSelect}
                  ></diff-file-tree>
                </div>
              </div>
              ${keyed(store.projectId, html`<diff-panel
                class="flex-1 min-h-0 ${this.activeTab === "changes" ? "" : "hidden"}"
                .store=${this.diffStore}
                .treeState=${this.fileTreeState}
                .visible=${this.activeTab === "changes"}
              ></diff-panel>`)}
            </div>
          ` : this.renderEmptyState()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
