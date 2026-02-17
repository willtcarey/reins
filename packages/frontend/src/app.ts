/**
 * App Shell
 *
 * Root component with session sidebar, chat panel, and diff panel.
 * Initializes the WebSocket client and wires everything together.
 * Uses light DOM for Tailwind compatibility.
 *
 * Routing: hash-based
 *  - `#/project/:id` — view a saved project
 *  - (empty hash)    — no project selected, show empty state
 */

import { LitElement, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, state } from "lit/decorators.js";
import { AppClient } from "./ws-client.js";
import type { SessionData, SessionListItem } from "./ws-client.js";
import type { SessionSidebar } from "./session-sidebar.js";
import type { DiffPanel } from "./changes/diff-panel.js";
import { DiffStore } from "./changes/diff-store.js";
import { FileTreeState } from "./changes/file-tree-state.js";
import { ActivityTracker } from "./activity-tracker.js";


// Ensure sub-components are registered
import "./chat-panel.js";
import "./changes/diff-panel.js";
import "./changes/diff-file-tree.js";
import "./session-sidebar.js";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

/** Parse `#/project/3` → 3, anything else → null */
function parseProjectIdFromHash(): number | null {
  const match = location.hash.match(/^#\/project\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

@customElement("app-shell")
export class AppShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private client = new AppClient();
  private diffStore = new DiffStore();
  private fileTreeState = new FileTreeState();
  private activityTracker = new ActivityTracker();


  @state() private connected = false;
  @state() private activeSessionId = "";
  @state() private activeProjectId: number | null = null;
  @state() private sessionData: SessionData | null = null;
  @state() private activeTab: "chat" | "changes" = "chat";
  @state() private activityMap = new Map<string, import("./activity-tracker.js").ActivityState>();

  override connectedCallback() {
    super.connectedCallback();

    // Read initial route
    this.activeProjectId = parseProjectIdFromHash();
    this.diffStore.setProject(this.activeProjectId);

    // Listen for hash changes (project switches)
    window.addEventListener("hashchange", this.onHashChange);

    this.client.onConnection((connected) => {
      this.connected = connected;
      // On reconnect, re-fetch the active session to catch up on missed events
      if (connected && this.activeSessionId) {
        this.fetchSession(this.activeSessionId);
      }
    });

    // Track session activity and refresh diff panel
    this.client.onEvent((sessionId, event) => {
      // Track activity for all sessions
      if (sessionId && event.type === "agent_start") {
        this.activityTracker.setRunning(sessionId);
      } else if (sessionId && event.type === "agent_end") {
        this.activityTracker.setFinished(sessionId, this.activeSessionId);
        setTimeout(() => this.getSidebar()?.refresh(), 500);
      }

      // Only refresh diff for the session we're viewing
      if (sessionId !== this.activeSessionId) return;

      const refreshDiff =
        (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName)) ||
        event.type === "agent_end";

      if (refreshDiff) {
        setTimeout(() => this.diffStore.refresh(), 500);
      }
    });

    // React to activity state changes (favicon, title, sidebar)
    this.activityTracker.onChange(() => {
      this.activityMap = this.activityTracker.getAll();
      this.updateTitleAndFavicon();
    });

    this.client.connect();

    // Load initial session for the current project (uses REST, not WS)
    if (this.activeProjectId != null) {
      this.loadProjectSession();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onHashChange);
    this.client.disconnect();
    this.diffStore.dispose();

  }

  private onHashChange = () => {
    const newProjectId = parseProjectIdFromHash();
    if (newProjectId !== this.activeProjectId) {
      this.activeProjectId = newProjectId;
      this.activeSessionId = "";
      this.sessionData = null;
      this.diffStore.setProject(newProjectId);
      this.fileTreeState.reset();

      if (newProjectId != null) {
        this.loadProjectSession();
      }
    }
  };

  private getSidebar(): SessionSidebar | null {
    return this.querySelector("session-sidebar") as SessionSidebar | null;
  }

  /**
   * Fetch a single session's full data via REST and apply it.
   */
  private async fetchSession(sessionId: string): Promise<boolean> {
    if (this.activeProjectId == null) return false;
    try {
      const resp = await fetch(
        `/api/projects/${this.activeProjectId}/sessions/${encodeURIComponent(sessionId)}`
      );
      if (!resp.ok) return false;
      this.loadSession(await resp.json());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load the most recent session for the current project via REST.
   * Fetches the session list first (sidebar uses this too), then loads
   * the most recent one. If no sessions exist, leaves sessionData null.
   */
  private async loadProjectSession() {
    if (this.activeProjectId == null) return;
    try {
      const listResp = await fetch(`/api/projects/${this.activeProjectId}/sessions`);
      if (!listResp.ok) return;
      const sessions: SessionListItem[] = await listResp.json();

      // Let the sidebar know about the list
      this.getSidebar()?.setSessionList(sessions);

      if (sessions.length === 0) return;

      // Load the most recent session's full data
      await this.fetchSession(sessions[0].id);
    } catch {
      // Silently fail — user can retry via sidebar
    }
  }

  /**
   * Called by the session sidebar when the user clicks a session or creates a new one.
   */
  public loadSession(data: SessionData) {
    this.sessionData = data;
    this.activeSessionId = data.id;
    // Clear "finished" notification for this session (user is now viewing it)
    this.activityTracker.clear(data.id);
    this.getSidebar()?.refresh();
  }

  private updateTitleAndFavicon(): void {
    const { running, finished } = this.activityTracker.summary;

    // Update document title
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
    // Wait one frame for the diff panel to become visible, then scroll
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
    const hasProject = this.activeProjectId != null;

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
            .client=${this.client}
            .activeSessionId=${this.activeSessionId}
            .activeProjectId=${this.activeProjectId}
            .activityMap=${this.activityMap}
          ></session-sidebar>

          ${hasProject ? html`
            <div class="flex-1 flex flex-col min-w-0">
              <!-- Tab bar -->
              <div class="flex items-center border-b border-zinc-700 bg-zinc-800/50">
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
                  .sessionId=${this.activeSessionId}
                  .sessionData=${this.sessionData}
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
              ${keyed(this.activeProjectId, html`<diff-panel
                class="flex-1 min-h-0 ${this.activeTab === "changes" ? "" : "hidden"}"
                .store=${this.diffStore}
                .treeState=${this.fileTreeState}
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
