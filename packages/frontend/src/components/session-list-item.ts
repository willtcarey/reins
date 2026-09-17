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
import type { InfoCardAction } from "../ui/info-card.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import { formatRelativeDate } from "../models/format.js";
import { selectSessionEvent } from "./events.js";
import "./activity-dot.js";
import "./delegate-popover.js";
import { showToast } from "./toast.js";
import "../ui/info-card.js";

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
  childSessions: SessionListItemData[] = [];

  @property({ type: String })
  activeSessionId = "";

  @property({ attribute: false })
  onSetSessionUnread: ((sessionId: string, unread: boolean) => Promise<unknown>) | null = null;

  private handleClick() {
    this.dispatchEvent(selectSessionEvent(this.session.id, this.session.projectId));
  }

  private cardActions(): InfoCardAction[] {
    const actions: InfoCardAction[] = [{
      label: "Copy session ID",
      run: () => this.copySessionId(),
    }];
    if (!this.onSetSessionUnread || this.session.activityState === "running") return actions;

    const unread = this.session.activityState === "finished";
    actions.push({
      label: unread ? "Mark as read" : "Mark as unread",
      run: () => this.onSetSessionUnread?.(this.session.id, !unread),
    });
    return actions;
  }

  private async copySessionId() {
    try {
      await copyTextToClipboard(this.session.id);
      showToast("Session ID copied", "success");
    } catch {
      showToast("Could not copy session ID", "error");
    }
  }

  override render() {
    const s = this.session;
    if (!s) return nothing;

    const label = s.name || s.firstMessage || "Empty session";
    const date = formatRelativeDate(s.updatedAt);
    const childCount = this.childSessions.length;

    return html`
      <info-card
        class="block"
        data-session-id=${s.id}
        .title=${label}
        .subtitle=${`${date} · ${s.messageCount} messages`}
        .active=${this.active}
        .primaryLabel=${`Open session: ${label}`}
        .actions=${this.cardActions()}
        .trailing=${s.activityState || childCount > 0 ? html`
          <span class="flex items-center gap-1.5">
            ${s.activityState ? html`
              <activity-dot class="shrink-0" .state=${s.activityState}></activity-dot>
            ` : nothing}
            ${childCount > 0 ? html`
              <delegate-popover
                .childSessions=${this.childSessions}
                .activeSessionId=${this.activeSessionId}
                .onSetSessionUnread=${this.onSetSessionUnread}
              ></delegate-popover>
            ` : nothing}
          </span>
        ` : nothing}
        @info-card-activate=${this.handleClick}
      ></info-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-list-item": SessionListItem;
  }
}
