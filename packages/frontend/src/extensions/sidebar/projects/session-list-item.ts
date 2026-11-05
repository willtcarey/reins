/**
 * Session List Item
 *
 * A session's row in the Projects section: its name, activity, when it changed, its message count, and a
 * delegate popover badge when it has started sub-sessions. Its actions go through the SDK's sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Sessions, SessionSummary } from "@reins/sdk";
import type { InfoCardAction } from "../../../ui/info-card.js";
import { copyTextToClipboard } from "../../../helpers/clipboard.js";
import { formatRelativeDate } from "../../../models/format.js";
import { pinIcon } from "../../../ui/icons.js";
import { moveSessionEvent, renameSessionEvent, selectSessionEvent } from "../../../components/events.js";
import { showToast } from "../../../ui/toast.js";
import { appActivity } from "./activity.js";
import "../../../components/activity-dot.js";
import "./delegate-popover.js";
import "../../../ui/info-card.js";

@customElement("session-list-item")
export class SessionListItem extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  session!: SessionSummary;

  @property({ type: Boolean })
  active = false;

  @property({ attribute: false })
  childSessions: SessionSummary[] = [];

  @property({ type: String })
  activeSessionId = "";

  /** What its actions use; without it, the row only opens and copies its ID. */
  @property({ attribute: false })
  sessions: Sessions | null = null;

  /** Whether it offers Move (whoever lists it handles `move-session`). */
  @property({ type: Boolean })
  movable = true;

  private handleClick = (event: Event) => {
    event.stopPropagation();
    this.dispatchEvent(selectSessionEvent(this.session.id, this.session.projectId));
  };

  private async act(run: (sessions: Sessions) => Promise<void>) {
    if (!this.sessions) return;
    try {
      await run(this.sessions);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private cardActions(): InfoCardAction[] {
    const session = this.session;
    const actions: InfoCardAction[] = [{
      label: "Copy session ID",
      run: () => this.copySessionId(),
    }];
    if (this.sessions && session.activity !== "running") {
      const unread = session.activity === "unread";
      actions.push({
        label: unread ? "Mark as read" : "Mark as unread",
        run: () => this.act((sessions) => sessions.setUnread(session.id, !unread)),
      });
    }
    if (this.movable) actions.push(this.moveAction());
    if (this.sessions) {
      actions.push({
        label: "Rename",
        run: () => this.dispatchEvent(renameSessionEvent(session.id)),
      }, {
        label: session.pinned ? "Unpin" : "Pin",
        run: () => this.act((sessions) => sessions.setPinned(session.id, !session.pinned)),
      }, {
        label: session.archived ? "Unarchive" : "Archive",
        tone: session.archived ? "default" : "danger",
        run: () => this.act((sessions) => sessions.setArchived(session.id, !session.archived)),
      });
    }
    return actions;
  }

  /** The session's node (marked if it was removed: the session then takes no work until moved), and
   * whether it can move now: not while it runs. */
  private moveAction(): InfoCardAction {
    const { nodeName, nodeRemoved, activity } = this.session;
    const unavailable = activity === "running" ? "Unavailable while the session is running" : null;
    return {
      label: "Move session…",
      detail: unavailable ?? `Node: ${nodeName}${nodeRemoved ? " (removed)" : ""}`,
      disabled: unavailable !== null,
      run: () => this.dispatchEvent(moveSessionEvent(this.session.id)),
    };
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
        .titlePrefix=${s.pinned ? html`
          <span
            data-role="pinned-session-indicator"
            class="pointer-events-none block text-zinc-600"
          >${pinIcon("", 10)}</span>
        ` : nothing}
        .subtitle=${`${date} · ${s.messageCount} messages${s.startedBy ? ` · from ${s.startedBy}` : ""}`}
        .active=${this.active}
        .primaryLabel=${`Open session: ${label}`}
        .actions=${this.cardActions()}
        .trailing=${s.activity || childCount > 0 ? html`
          <span class="flex items-center gap-1.5">
            ${s.activity ? html`
              <activity-dot class="shrink-0" .state=${appActivity(s.activity)}></activity-dot>
            ` : nothing}
            ${childCount > 0 ? html`
              <delegate-popover
                .childSessions=${this.childSessions}
                .activeSessionId=${this.activeSessionId}
                .sessions=${this.sessions}
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
