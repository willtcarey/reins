/**
 * Session List Item
 *
 * Renders a single session row in the task's session list.
 * Displays session name, activity indicator, timestamp, message count,
 * and a delegate popover badge when the session has spawned sub-sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListView as SessionListItemData } from "@backend/models/sessions.js";
import type { InfoCardAction } from "../ui/info-card.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import { formatRelativeDate } from "../models/format.js";
import { pinIcon } from "../ui/icons.js";
import { renameSessionEvent, selectSessionEvent } from "./events.js";
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

  @property({ attribute: false })
  onUpdateMetadata: ((sessionId: string, updates: { name?: string | null; pinned?: boolean; archived?: boolean }) => Promise<unknown>) | null = null;

  private handleClick = (event: Event) => {
    event.stopPropagation();
    this.dispatchEvent(selectSessionEvent(this.session.id, this.session.projectId));
  };

  private cardActions(pinned: boolean): InfoCardAction[] {
    const actions: InfoCardAction[] = [{
      label: "Copy session ID",
      run: () => this.copySessionId(),
    }];
    if (this.onSetSessionUnread && this.session.activityState !== "running") {
      const unread = this.session.activityState === "finished";
      actions.push({
        label: unread ? "Mark as read" : "Mark as unread",
        run: () => this.onSetSessionUnread?.(this.session.id, !unread),
      });
    }
    if (this.onUpdateMetadata) {
      actions.push({
        label: "Rename",
        run: () => this.dispatchEvent(renameSessionEvent(this.session.id)),
      }, {
        label: pinned ? "Unpin" : "Pin",
        run: () => this.onUpdateMetadata?.(this.session.id, { pinned: !pinned }),
      }, {
        label: this.session.archivedAt ? "Unarchive" : "Archive",
        tone: this.session.archivedAt ? "default" : "danger",
        run: () => this.onUpdateMetadata?.(this.session.id, { archived: !this.session.archivedAt }),
      });
    }
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
    const pinned = s.pinnedAt !== null;
    const scheduling = s.scheduling && s.scheduling.state !== "admitted"
      ? s.scheduling.state === "queued" && !s.scheduling.available ? "Source unavailable · queued"
        : s.scheduling.state === "unknown" ? "Open outcome unknown"
          : s.scheduling.state === "failed" ? `Open failed: ${s.scheduling.error ?? "unknown error"}`
            : `Open ${s.scheduling.state}`
      : null;

    return html`
      <info-card
        class="block"
        data-session-id=${s.id}
        .title=${label}
        .titlePrefix=${pinned ? html`
          <span
            data-role="pinned-session-indicator"
            class="pointer-events-none block text-zinc-600"
          >${pinIcon("", 10)}</span>
        ` : nothing}
        .subtitle=${scheduling ? `${scheduling} · ${date}` : `${date} · ${s.messageCount} messages`}
        .active=${this.active}
        .primaryLabel=${`Open session: ${label}`}
        .actions=${this.cardActions(pinned)}
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
                .onUpdateMetadata=${this.onUpdateMetadata}
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
