/**
 * Delegate Popover
 *
 * Renders a "+N" badge for sessions that have spawned delegate sub-sessions.
 * Clicking the badge opens a popover listing the child sessions.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListItem } from "../models/ws-client.js";
import type { ActivityState } from "../models/tasks.js";
import { formatRelativeDate } from "../models/format.js";
import "./activity-dot.js";
import "./popover-menu.js";

/**
 * Build a map of parent session ID → child sessions from a flat session list.
 */
export function buildChildMap(sessions: SessionListItem[]): Map<string, SessionListItem[]> {
  const map = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    if (s.parent_session_id) {
      const children = map.get(s.parent_session_id) ?? [];
      children.push(s);
      map.set(s.parent_session_id, children);
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

  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  @property({ type: String })
  activeSessionId = "";

  private hasRunningChild(): boolean {
    return this.childSessions.some(c => this.activityMap.get(c.id) === "running");
  }

  private handleSelectSession(sessionId: string) {
    this.dispatchEvent(
      new CustomEvent("select-session", {
        bubbles: true,
        composed: true,
        detail: { sessionId },
      }),
    );
  }

  private renderPopoverContent() {
    return html`
      <div class="px-3 py-1 text-[10px] text-zinc-500 uppercase tracking-wide font-semibold">Delegate sub-sessions</div>
      <div class="max-h-48 overflow-y-auto">
        ${this.childSessions.map(child => {
          const label = child.name || child.first_message || "Sub-session";
          const truncated = label.length > 40 ? label.slice(0, 40) + "…" : label;
          const isActive = child.id === this.activeSessionId;
          const date = formatRelativeDate(child.updated_at);
          return html`
            <button
              data-session-id=${child.id}
              class="w-full text-left px-3 py-1.5 cursor-pointer transition-colors flex items-center gap-1.5
                ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700"}"
              @click=${() => this.handleSelectSession(child.id)}
            >
              <activity-dot .state=${this.activityMap.get(child.id)} .runningOnly=${true}></activity-dot>
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

  override render() {
    const childCount = this.childSessions.length;
    const running = this.hasRunningChild();

    return html`
      <popover-menu
        triggerClass="!p-0 !px-1 !py-1.5 !opacity-100"
        panelClass="w-64"
        anchor="right-start"
        .content=${() => this.renderPopoverContent()}
        .triggerTemplate=${html`
          <span
            class="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 transition-colors
              ${running
                ? "bg-blue-500/30 text-blue-300 animate-pulse"
                : "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"}"
            title="${running
              ? `${childCount} delegate sub-session${childCount !== 1 ? "s" : ""} (running)`
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
