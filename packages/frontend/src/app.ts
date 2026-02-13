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
import { customElement, state } from "lit/decorators.js";
import { AppClient } from "./ws-client.js";
import type { SessionData, SessionListItem } from "./ws-client.js";
import type { ChatPanel } from "./chat-panel.js";
import type { DiffPanel } from "./diff-panel.js";
import type { SessionSidebar } from "./session-sidebar.js";

// Ensure sub-components are registered
import "./chat-panel.js";
import "./diff-panel.js";
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

  @state() private connected = false;
  @state() private activeSessionId = "";
  @state() private activeProjectId: number | null = null;
  @state() private sessionData: SessionData | null = null;
  @state() private activeTab: "chat" | "changes" = "chat";

  /** Tracks whether we've loaded the initial session for the current project. */
  private projectSessionLoaded = false;

  override connectedCallback() {
    super.connectedCallback();

    // Read initial route
    this.activeProjectId = parseProjectIdFromHash();

    // Listen for hash changes (project switches)
    window.addEventListener("hashchange", this.onHashChange);

    this.client.onConnection((connected) => {
      this.connected = connected;
      // When WS connects (or reconnects), load the session for the current project
      if (connected && !this.projectSessionLoaded && this.activeProjectId != null) {
        this.loadProjectSession();
      }
    });

    // Refresh diff panel when file-modifying tools complete
    this.client.onEvent((sessionId, event) => {
      // Only react to events for the session we're viewing
      if (sessionId !== this.activeSessionId) return;

      if (
        event.type === "tool_execution_end" &&
        FILE_MODIFYING_TOOLS.has(event.toolName)
      ) {
        setTimeout(() => {
          const diffPanel = this.querySelector("diff-panel") as DiffPanel | null;
          diffPanel?.refresh();
        }, 500);
      }

      if (event.type === "agent_end") {
        setTimeout(() => {
          const diffPanel = this.querySelector("diff-panel") as DiffPanel | null;
          diffPanel?.refresh();
        }, 500);
      }
    });

    this.client.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onHashChange);
    this.client.disconnect();
  }

  private onHashChange = () => {
    const newProjectId = parseProjectIdFromHash();
    if (newProjectId !== this.activeProjectId) {
      this.activeProjectId = newProjectId;
      this.projectSessionLoaded = false;
      this.activeSessionId = "";
      this.sessionData = null;

      if (newProjectId != null) {
        this.loadProjectSession();
      }
    }
  };

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
      const sidebar = this.querySelector("session-sidebar") as SessionSidebar | null;
      sidebar?.setSessionList(sessions);

      if (sessions.length === 0) {
        this.projectSessionLoaded = true;
        return;
      }

      // Load the most recent session's full data
      const latest = sessions[0];
      const resp = await fetch(
        `/api/projects/${this.activeProjectId}/sessions/${encodeURIComponent(latest.id)}`
      );
      if (!resp.ok) return;
      const data: SessionData = await resp.json();
      this.sessionData = data;
      this.activeSessionId = data.id;
      this.projectSessionLoaded = true;
    } catch {
      // Will retry on next connect
    }
  }

  /**
   * Called by the session sidebar when the user clicks a session or creates a new one.
   */
  public loadSession(data: SessionData) {
    this.sessionData = data;
    this.activeSessionId = data.id;
    const sidebar = this.querySelector("session-sidebar") as SessionSidebar | null;
    sidebar?.refresh();
  }

  private handleRefreshDiff() {
    const diffPanel = this.querySelector("diff-panel") as DiffPanel | null;
    diffPanel?.refresh();
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
      <div class="h-screen w-screen flex flex-col bg-zinc-900 text-zinc-100 overflow-hidden">
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
              <chat-panel
                class="flex-1 min-h-0 ${this.activeTab === "chat" ? "" : "hidden"}"
                .client=${this.client}
                .sessionId=${this.activeSessionId}
                .sessionData=${this.sessionData}
              ></chat-panel>
              <diff-panel
                class="flex-1 min-h-0 ${this.activeTab === "changes" ? "" : "hidden"}"
                .activeProjectId=${this.activeProjectId}
              ></diff-panel>
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
