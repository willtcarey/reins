/**
 * Herald App Shell
 *
 * Root component with session sidebar, chat panel, and diff panel.
 * Initializes the WebSocket client and wires everything together.
 * Uses light DOM for Tailwind compatibility.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { HeraldClient } from "./ws-client.js";
import type { HeraldChat } from "./chat-panel.js";
import type { HeraldDiff } from "./diff-panel.js";
import type { HeraldSessions } from "./session-sidebar.js";

// Ensure sub-components are registered
import "./chat-panel.js";
import "./diff-panel.js";
import "./session-sidebar.js";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

@customElement("herald-app")
export class HeraldApp extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private client = new HeraldClient();

  @state() private connected = false;
  @state() private activeSessionId = "";

  override connectedCallback() {
    super.connectedCallback();

    this.client.onConnection((connected) => {
      this.connected = connected;
    });

    // Track active session and refresh sidebar on session changes
    this.client.onInit((data) => {
      this.activeSessionId = data.sessionId;
      const sidebar = this.querySelector("herald-sessions") as HeraldSessions | null;
      sidebar?.refresh();
    });

    // Refresh diff panel when file-modifying tools complete
    this.client.onEvent((event) => {
      if (
        event.type === "tool_execution_end" &&
        FILE_MODIFYING_TOOLS.has(event.toolName)
      ) {
        setTimeout(() => {
          const diffPanel = this.querySelector("herald-diff") as HeraldDiff | null;
          diffPanel?.refresh();
        }, 500);
      }

      if (event.type === "agent_end") {
        setTimeout(() => {
          const diffPanel = this.querySelector("herald-diff") as HeraldDiff | null;
          diffPanel?.refresh();
        }, 500);
      }
    });

    this.client.connect();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.client.disconnect();
  }

  private handleRefreshDiff() {
    const diffPanel = this.querySelector("herald-diff") as HeraldDiff | null;
    diffPanel?.refresh();
  }

  override render() {
    return html`
      <div class="h-screen w-screen flex flex-col bg-zinc-900 text-zinc-100">
        <!-- Connection status bar -->
        ${!this.connected ? html`
          <div class="bg-yellow-800 text-yellow-200 text-xs text-center py-1">
            Connecting to server...
          </div>
        ` : ""}

        <!-- Main layout: sidebar + chat + diff -->
        <div class="flex-1 flex min-h-0">
          <!-- Session sidebar -->
          <herald-sessions
            .client=${this.client}
            .activeSessionId=${this.activeSessionId}
          ></herald-sessions>

          <!-- Chat panel -->
          <div class="flex-1 flex flex-col border-r border-zinc-700 min-w-0">
            <div class="flex items-center justify-between px-4 py-2 border-b border-zinc-700 bg-zinc-800/50">
              <h2 class="text-sm font-semibold text-zinc-300">Chat</h2>
              <div class="flex items-center gap-2">
                ${this.connected
                  ? html`<span class="w-2 h-2 rounded-full bg-green-500" title="Connected"></span>`
                  : html`<span class="w-2 h-2 rounded-full bg-red-500" title="Disconnected"></span>`
                }
              </div>
            </div>
            <herald-chat class="flex-1 min-h-0" .client=${this.client}></herald-chat>
          </div>

          <!-- Diff panel -->
          <div class="w-1/2 flex flex-col shrink-0">
            <div class="flex items-center justify-between px-4 py-2 border-b border-zinc-700 bg-zinc-800/50">
              <h2 class="text-sm font-semibold text-zinc-300">Changes</h2>
              <button
                class="text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                @click=${this.handleRefreshDiff}
                title="Refresh diff"
              >
                Refresh
              </button>
            </div>
            <herald-diff class="flex-1 min-h-0"></herald-diff>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "herald-app": HeraldApp;
  }
}
