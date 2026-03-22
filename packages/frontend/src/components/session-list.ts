/**
 * Session List
 *
 * Renders the assistant session (most recent scratch session) as a plain row.
 * A popover menu provides "New conversation" and access to previous sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionListItem } from "../models/ws-client.js";
import type { ActivityState } from "../models/stores/app-store.js";
import { formatRelativeDate } from "../models/format.js";
import "./popover-menu.js";

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

  /** Set of parent session IDs whose sub-sessions are expanded in the popover. */
  @state() private expandedDelegates = new Set<string>();

  /** Build a map of parent session ID → child sessions. */
  private getChildMap(): Map<string, SessionListItem[]> {
    const map = new Map<string, SessionListItem[]>();
    for (const s of this.sessions) {
      if (s.parent_session_id) {
        const children = map.get(s.parent_session_id) ?? [];
        children.push(s);
        map.set(s.parent_session_id, children);
      }
    }
    return map;
  }

  private toggleDelegates(parentId: string, e: Event) {
    e.stopPropagation();
    const next = new Set(this.expandedDelegates);
    if (next.has(parentId)) {
      next.delete(parentId);
    } else {
      next.add(parentId);
    }
    this.expandedDelegates = next;
  }

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

  private renderDelegateSubSessions(parentId: string) {
    if (!this.expandedDelegates.has(parentId)) return nothing;

    const childMap = this.getChildMap();
    const children = childMap.get(parentId) ?? [];
    if (children.length === 0) return nothing;

    return html`
      <div class="pl-7 bg-zinc-800/40 border-t border-zinc-700/50">
        ${children.map(child => {
          const label = child.name || child.first_message || "Sub-session";
          const truncated = label.length > 50 ? label.slice(0, 50) + "…" : label;
          const isActive = child.id === this.activeSessionId;
          const date = formatRelativeDate(child.updated_at);
          return html`
            <button
              data-session-id=${child.id}
              class="w-full text-left px-3 py-1.5 cursor-pointer transition-colors flex items-center gap-1.5
                ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700/30"}"
              @click=${() => this.handleSelectSession(child.id)}
            >
              ${this.renderActivityDot(child.id)}
              <span class="text-[9px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-400 shrink-0">sub</span>
              <div class="min-w-0 flex-1">
                <div class="text-xs ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${truncated}</div>
                <div class="text-[10px] text-zinc-500">${date} · ${child.message_count} msg</div>
              </div>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderSessionMenuContent() {
    const childMap = this.getChildMap();
    // Filter out sub-sessions from previous list — they appear under their parents
    const previous = this.sessions.slice(1).filter(s => !s.parent_session_id);

    return html`
      <button
        class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
        @click=${this.handleNewSession}
      >New conversation</button>
      ${previous.length > 0 ? html`
        <div class="border-t border-zinc-700 my-1"></div>
        <div class="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wide font-semibold">Previous</div>
        <div class="max-h-48 overflow-y-auto">
          ${previous.map(s => {
            const label = s.name || s.first_message || "Empty session";
            const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
            const date = formatRelativeDate(s.updated_at);
            const isActive = s.id === this.activeSessionId;
            const childCount = childMap.get(s.id)?.length ?? 0;
            return html`
              <button
                class="w-full text-left px-3 py-1.5 cursor-pointer transition-colors
                  ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700"}"
                @click=${() => this.handleSelectSession(s.id)}
              >
                <div class="flex items-center gap-1.5">
                  <div class="text-xs ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${truncated}</div>
                  ${childCount > 0 ? html`
                    <span class="text-[9px] px-1 py-0.5 rounded-full bg-blue-500/20 text-blue-400 shrink-0">+${childCount}</span>
                  ` : nothing}
                </div>
                <div class="text-[10px] text-zinc-500">${date} · ${s.message_count} msg</div>
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
      const childMap = this.getChildMap();
      const childCount = childMap.get(assistant.id)?.length ?? 0;
      return html`
        <div class="border-b border-zinc-700 group/assistant">
          <div class="flex items-center">
            <button
              data-session-id=${assistant.id}
              class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer text-left transition-colors hover:bg-zinc-700/30
                ${isActive ? "bg-zinc-700/60" : ""}"
              @click=${() => this.handleSelectSession(assistant.id)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-zinc-500"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${this.renderActivityDot(assistant.id)}
              <span class="text-xs ${isActive ? "text-zinc-100 font-medium" : "text-zinc-300"} truncate">Assistant</span>
              ${childCount > 0 ? html`
                <button
                  class="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 shrink-0 cursor-pointer transition-colors"
                  title="Show ${childCount} delegate sub-session${childCount !== 1 ? "s" : ""}"
                  @click=${(e: Event) => this.toggleDelegates(assistant.id, e)}
                >+${childCount}</button>
              ` : nothing}
            </button>
            <popover-menu
              triggerClass="md:opacity-0 md:group-hover/assistant:opacity-100"
              panelClass="w-60"
              .content=${() => this.renderSessionMenuContent()}
            ></popover-menu>
          </div>
          ${this.renderDelegateSubSessions(assistant.id)}
        </div>
      `;
    }

    return html`
      <div class="border-b border-zinc-700">
        <div class="flex items-center">
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
    "session-list": SessionList;
  }
}
