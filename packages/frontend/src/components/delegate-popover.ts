/**
 * Delegate Popover
 *
 * Renders a "+N" badge for sessions that have spawned delegate sub-sessions.
 * Clicking the badge opens a popover listing the child sessions.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListItem } from "../models/ws-client.js";
import "./session-list-item.js";
import "../ui/popover-menu.js";

/**
 * Build a map of session ID → all delegate descendants from a flat session list.
 */
export function buildDescendantMap(sessions: SessionListItem[]): Map<string, SessionListItem[]> {
  const map = new Map<string, SessionListItem[]>();
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));

  for (const session of sessions) {
    let ancestorId = session.parentSessionId;
    const visited = new Set<string>();
    while (ancestorId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      const descendants = map.get(ancestorId) ?? [];
      descendants.push(session);
      map.set(ancestorId, descendants);
      ancestorId = sessionsById.get(ancestorId)?.parentSessionId ?? null;
    }
  }
  return map;
}

@customElement("delegate-popover")
export class DelegatePopover extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  childSessions: SessionListItem[] = [];

  @property({ type: String })
  activeSessionId = "";

  @property({ attribute: false })
  onSetSessionUnread: ((sessionId: string, unread: boolean) => Promise<unknown>) | null = null;

  @property({ attribute: false })
  onUpdateMetadata: ((sessionId: string, updates: { name?: string | null; pinned?: boolean; archived?: boolean }) => Promise<unknown>) | null = null;

  private hasRunningChild(): boolean {
    return this.childSessions.some(c => c.activityState === "running");
  }

  private hasUnreadChild(): boolean {
    return this.childSessions.some(c => c.activityState === "finished");
  }

  private markAllRead() {
    const markUnread = this.onSetSessionUnread;
    if (!markUnread) return;
    void Promise.all(
      this.childSessions
        .filter((child) => child.activityState === "finished")
        .map((child) => markUnread(child.id, false)),
    );
  }

  private renderPopoverContent() {
    const canUpdateUnread = this.onSetSessionUnread !== null;
    return html`
      <div class="px-3 py-1 flex items-center gap-2 text-[10px] uppercase tracking-wide font-semibold">
        <span class="flex-1 text-zinc-500">Delegate sub-sessions</span>
        ${canUpdateUnread && this.hasUnreadChild() ? html`
          <button
            class="text-amber-400 hover:text-amber-300 cursor-pointer normal-case tracking-normal"
            @click=${() => this.markAllRead()}
          >Mark all as read</button>
        ` : null}
      </div>
      <div class="max-h-48 overflow-y-auto">
        ${this.childSessions.map(child => html`
          <session-list-item
            class="block"
            .session=${child}
            .active=${child.id === this.activeSessionId}
            .activeSessionId=${this.activeSessionId}
            .onSetSessionUnread=${this.onSetSessionUnread}
            .onUpdateMetadata=${this.onUpdateMetadata}
          ></session-list-item>
        `)}
      </div>
    `;
  }

  override render() {
    const childCount = this.childSessions.length;
    const running = this.hasRunningChild();
    const unread = this.hasUnreadChild();

    return html`
      <popover-menu
        triggerClass="!p-0 !flex !items-center !opacity-100"
        panelClass="w-64"
        anchor="right-start"
        close-on-panel-click
        .content=${() => this.renderPopoverContent()}
        .triggerTemplate=${html`
          <span
            class="h-4 inline-flex items-center text-[9px] leading-none px-1.5 md:px-1 rounded-full shrink-0 transition-colors
              ${running
                ? "bg-blue-500/30 text-blue-300 animate-pulse"
                : unread
                  ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                  : "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"}"
            title="${running
              ? `${childCount} delegate sub-session${childCount !== 1 ? "s" : ""} (running)`
              : unread
                ? `${childCount} delegate sub-session${childCount !== 1 ? "s" : ""} (unread activity)`
                : `Show ${childCount} delegate sub-session${childCount !== 1 ? "s" : ""}`}"
          >+${childCount}</span>
        `}
      ></popover-menu>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "delegate-popover": DelegatePopover;
  }
}
