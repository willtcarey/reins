/**
 * Session List
 *
 * Renders scratch (non-task) sessions for a project. Supports creating new
 * sessions and selecting existing ones via events.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListItem } from "./ws-client.js";
import type { ActivityState } from "./activity-tracker.js";
import { formatRelativeDate } from "./format.js";

@customElement("session-list")
export class SessionList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  sessions: SessionListItem[] = [];

  @property({ type: String })
  activeSessionId = "";

  /** Whether the project also has tasks — controls the section heading. */
  @property({ type: Boolean })
  hasTasks = false;

  /** Activity states for sessions (running/finished indicators). */
  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  private handleSelectSession(sessionId: string) {
    this.dispatchEvent(
      new CustomEvent("select-session", {
        bubbles: true,
        composed: true,
        detail: { sessionId },
      })
    );
  }

  private handleNewSession() {
    this.dispatchEvent(
      new CustomEvent("new-session", { bubbles: true, composed: true })
    );
  }

  private handleCollapse() {
    this.dispatchEvent(
      new CustomEvent("toggle-collapse", { bubbles: true, composed: true })
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

  private renderSession(s: SessionListItem) {
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
    return html`
      <!-- Divider between tasks and scratch sessions -->
      ${this.hasTasks && this.sessions.length > 0 ? html`
        <div class="border-b border-zinc-600"></div>
      ` : nothing}

      <div class="px-3 py-2 border-b border-zinc-700 flex items-center justify-between">
        <h2 class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">
          ${this.hasTasks ? "Scratch Sessions" : "Sessions"}
        </h2>
        <button
          class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
          @click=${this.handleCollapse}
          title="Hide sidebar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
      </div>

      <div class="p-2 border-b border-zinc-700">
        <button
          class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
          @click=${this.handleNewSession}
        >
          + New Session
        </button>
      </div>

      ${this.sessions.length === 0 ? html`
        <div class="p-3 text-xs text-zinc-500">No sessions yet</div>
      ` : this.sessions.map(s => this.renderSession(s))}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-list": SessionList;
  }
}
