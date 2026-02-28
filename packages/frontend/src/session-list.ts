/**
 * Session List
 *
 * Renders the assistant session (most recent scratch session) pinned at the
 * top, with older sessions in a collapsible "Previous conversations" section.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionListItem } from "./ws-client.js";
import type { ActivityState } from "./stores/app-store.js";
import { formatRelativeDate } from "./format.js";

@customElement("session-list")
export class SessionList extends LitElement {
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

  @state() private previousExpanded = false;

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

  private renderAssistantButton(s: SessionListItem) {
    const isActive = s.id === this.activeSessionId;

    return html`
      <div class="border-b border-zinc-700">
        <div class="px-3 py-2">
          <div class="flex items-center gap-2">
            <button
              class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-colors text-left
                ${isActive ? "bg-zinc-700/60 text-zinc-100" : "bg-zinc-800 hover:bg-zinc-700/40 text-zinc-300"}"
              @click=${() => this.handleSelectSession(s.id)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-zinc-400"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${this.renderActivityDot(s.id)}
              <span class="text-xs font-medium truncate">Assistant</span>
            </button>
            <button
              class="p-1.5 text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors shrink-0"
              @click=${this.handleNewSession}
              title="New conversation"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderPreviousSession(s: SessionListItem) {
    const isActive = s.id === this.activeSessionId;
    const label = s.name || s.first_message || "Empty session";
    const truncated = label.length > 60 ? label.slice(0, 60) + "..." : label;
    const date = formatRelativeDate(s.updated_at);

    return html`
      <button
        class="w-full text-left px-3 py-2 border-b border-zinc-700/50 cursor-pointer transition-colors
          ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700/30"}"
        @click=${() => this.handleSelectSession(s.id)}
      >
        <div class="flex items-center gap-1.5">
          ${this.renderActivityDot(s.id)}
          <div class="text-xs ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${truncated}</div>
        </div>
        <div class="text-[10px] text-zinc-500 mt-0.5">${date} · ${s.message_count} messages</div>
      </button>
    `;
  }

  override render() {
    const assistant = this.sessions.length > 0 ? this.sessions[0] : null;
    const previous = this.sessions.slice(1);

    return html`
      <!-- Assistant button -->
      ${assistant ? this.renderAssistantButton(assistant) : html`
        <div class="border-b border-zinc-700">
          <div class="px-3 py-2">
            <button
              class="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700/40 rounded cursor-pointer transition-colors"
              @click=${this.handleNewSession}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Start a conversation
            </button>
          </div>
        </div>
      `}

      <!-- Previous conversations -->
      ${previous.length > 0 ? html`
        <div class="border-b border-zinc-700">
          <button
            class="w-full px-3 py-1.5 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-400 cursor-pointer transition-colors"
            @click=${() => { this.previousExpanded = !this.previousExpanded; }}
          >
            <span class="font-mono">${this.previousExpanded ? "▼" : "▶"}</span>
            <span class="uppercase tracking-wide font-semibold">Previous conversations</span>
            <span class="text-zinc-600">(${previous.length})</span>
          </button>
          ${this.previousExpanded ? previous.map(s => this.renderPreviousSession(s)) : nothing}
        </div>
      ` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-list": SessionList;
  }
}
