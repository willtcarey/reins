/**
 * Session List Item
 *
 * Renders a single session row in the task's session list.
 * Displays session name, activity indicator, timestamp, message count,
 * and a delegate popover badge when the session has spawned sub-sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListItem as SessionListItemData } from "../models/ws-client.js";
import type { ActivityState } from "../models/stores/app-store.js";
import { formatRelativeDate } from "../models/format.js";
import "./activity-dot.js";
import "./delegate-popover.js";

@customElement("session-list-item")
export class SessionListItem extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  session!: SessionListItemData;

  @property({ type: Boolean })
  active = false;

  @property({ attribute: false })
  activityState: ActivityState | undefined;

  @property({ attribute: false })
  childSessions: SessionListItemData[] = [];

  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  @property({ type: String })
  activeSessionId = "";

  @property({ type: Number })
  projectId: number | null = null;

  private handleClick() {
    this.dispatchEvent(
      new CustomEvent("select-session", {
        bubbles: true,
        composed: true,
        detail: { projectId: this.projectId, sessionId: this.session.id },
      }),
    );
  }

  override render() {
    const s = this.session;
    if (!s) return nothing;

    const label = s.name || s.first_message || "Empty session";
    const truncated = label.length > 60 ? label.slice(0, 60) + "..." : label;
    const date = formatRelativeDate(s.updated_at);
    const childCount = this.childSessions.length;

    return html`
      <div class="border-b border-zinc-700/50 flex items-center">
        <button
          data-session-id=${s.id}
          class="flex-1 min-w-0 text-left px-3 py-2 cursor-pointer transition-colors
            ${this.active ? "bg-blue-500/15" : "hover:bg-zinc-700/30"}"
          @click=${this.handleClick}
        >
          <div class="flex items-center gap-1.5">
            <activity-dot .state=${this.activityState}></activity-dot>
            <div class="text-xs ${this.active ? "text-blue-300" : "text-zinc-300"} truncate">${truncated}</div>
          </div>
          <div class="text-[10px] text-zinc-500 mt-0.5">${date} · ${s.message_count} messages</div>
        </button>
        ${childCount > 0 ? html`
          <delegate-popover
            .childSessions=${this.childSessions}
            .activityMap=${this.activityMap}
            .activeSessionId=${this.activeSessionId}
          ></delegate-popover>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-list-item": SessionListItem;
  }
}
