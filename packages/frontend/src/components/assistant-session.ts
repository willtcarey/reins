/**
 * Assistant Session
 *
 * Renders the current assistant (scratch) session as a single sidebar row.
 * A popover menu provides "New conversation" and access to previous sessions.
 *
 * Scratch sessions cannot delegate, so there is no sub-session handling here.
 * Delegate sub-sessions are only relevant in task-list.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListItem } from "../models/ws-client.js";
import type { ActivityState } from "../models/stores/session-cache.js";
import { formatRelativeDate } from "../models/format.js";
import "./popover-menu.js";

@customElement("assistant-session")
export class AssistantSession extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @property({ attribute: false })
  sessions: SessionListItem[] = [];

  @property({ type: String })
  activeSessionId = "";

  /** Activity states for sessions (running/finished indicators). */
  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  private handleSelectSession(sessionId: string) {
    this.dispatchEvent(
      new CustomEvent("select-session", {
        bubbles: true,
        composed: true,
        detail: { projectId: this.projectId, sessionId },
      })
    );
  }

  private handleNewSession() {
    this.dispatchEvent(
      new CustomEvent("new-session", {
        bubbles: true,
        composed: true,
        detail: { projectId: this.projectId },
      })
    );
  }

  private renderActivityDot(sessionId: string) {
    const state = this.activityMap.get(sessionId);
    if (!state) return nothing;
    const classes = state === "running"
      ? "w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
      : "w-2 h-2 rounded-full bg-amber-500 shrink-0";
    return html`<span class="${classes}" title="${state === "running" ? "Running" : "New activity"}"></span>`;
  }

  private renderSessionMenuContent() {
    const previous = this.sessions.slice(1);

    return html`
      <button
        class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
        @click=${() => this.handleNewSession()}
      >New conversation</button>
      ${previous.length > 0 ? html`
        <div class="border-t border-zinc-700 my-1"></div>
        <div class="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wide font-semibold">Previous</div>
        <div class="max-h-48 overflow-y-auto">
          ${previous.map(s => {
            const label = s.name || s.firstMessage || "Empty session";
            const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
            const date = formatRelativeDate(s.updatedAt);
            const isActive = s.id === this.activeSessionId;
            return html`
              <button
                class="w-full text-left px-3 py-1.5 cursor-pointer transition-colors
                  ${isActive ? "bg-blue-500/15" : "hover:bg-zinc-700"}"
                @click=${() => this.handleSelectSession(s.id)}
              >
                <div class="text-xs ${isActive ? "text-blue-300" : "text-zinc-300"} truncate">${truncated}</div>
                <div class="text-[10px] text-zinc-500">${date} · ${s.messageCount} msg</div>
              </button>
            `;
          })}
        </div>
      ` : nothing}
    `;
  }

  override render() {
    const assistant = this.sessions.length > 0 ? this.sessions[0] : null;

    if (assistant) {
      const isActive = assistant.id === this.activeSessionId;
      return html`
        <div class="p-1 group/assistant">
          <div class="flex items-center rounded-md transition-colors ${isActive ? "bg-blue-500/15" : "hover:bg-zinc-800/70"}">
            <button
              data-session-id=${assistant.id}
              class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer text-left"
              @click=${() => this.handleSelectSession(assistant.id)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-zinc-500"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${this.renderActivityDot(assistant.id)}
              <span class="text-xs ${isActive ? "text-blue-300 font-medium" : "text-zinc-300"} truncate">Assistant</span>
            </button>
            <popover-menu
              triggerClass="md:opacity-0 md:group-hover/assistant:opacity-100"
              panelClass="w-60"
              close-on-panel-click
              .content=${() => this.renderSessionMenuContent()}
            ></popover-menu>
          </div>
        </div>
      `;
    }

    return html`
      <div class="p-1">
        <div class="flex items-center rounded-md hover:bg-zinc-800/70 transition-colors">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 cursor-pointer transition-colors text-left"
            @click=${this.handleNewSession}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span class="truncate">Start a conversation</span>
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "assistant-session": AssistantSession;
  }
}
