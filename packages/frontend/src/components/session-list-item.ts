/**
 * Session List Item
 *
 * Renders a single session row in the task's session list.
 * Displays session name, activity indicator, timestamp, message count,
 * and a delegate popover badge when the session has spawned sub-sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import type { SessionListItem as SessionListItemData } from "../models/ws-client.js";
import type { ActivityState } from "../models/stores/session-cache.js";
import { formatRelativeDate } from "../models/format.js";
import { selectSessionEvent } from "./events.js";
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

  @property({ type: String })
  activeSessionId = "";

  @property({ type: Number })
  projectId: number | null = null;

  @property({ attribute: false })
  onSetSessionUnread: ((sessionId: string, unread: boolean) => Promise<unknown>) | null = null;

  @state()
  private contextMenu: { x: number; y: number } | null = null;

  private handleClick() {
    this.dispatchEvent(selectSessionEvent(this.session.id, this.projectId));
  }

  private openContextMenu(event: Pick<MouseEvent, "preventDefault" | "clientX" | "clientY">) {
    if (!this.onSetSessionUnread || this.activityState === "running") return;
    event.preventDefault();
    this.contextMenu = { x: event.clientX, y: event.clientY };
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (!this.onSetSessionUnread || this.activityState === "running") return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    this.contextMenu = { x: rect.right, y: rect.bottom };
  }

  private closeContextMenu() {
    this.contextMenu = null;
  }

  private renderActivityActions() {
    const unread = this.activityState === "finished";
    return html`
      <button
        role="menuitem"
        class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
        @click=${() => {
          this.closeContextMenu();
          return this.onSetSessionUnread?.(this.session.id, !unread);
        }}
      >${unread ? "Mark as read" : "Mark as unread"}</button>
    `;
  }

  private contextMenuPosition() {
    if (!this.contextMenu) return {};
    const width = typeof window === "undefined" ? 1024 : window.innerWidth;
    const height = typeof window === "undefined" ? 768 : window.innerHeight;
    return {
      left: `${Math.max(8, Math.min(this.contextMenu.x, width - 168))}px`,
      top: `${Math.max(8, Math.min(this.contextMenu.y, height - 48))}px`,
    };
  }

  override updated() {
    const menu = this.querySelector<HTMLElement>("[data-role=session-activity-menu]");
    if (menu && !menu.matches(":popover-open")) {
      menu.showPopover();
      menu.querySelector<HTMLElement>("button")?.focus();
    }
  }

  override render() {
    const s = this.session;
    if (!s) return nothing;

    const label = s.name || s.firstMessage || "Empty session";
    const truncated = label.length > 60 ? label.slice(0, 60) + "..." : label;
    const date = formatRelativeDate(s.updatedAt);
    const childCount = this.childSessions.length;

    return html`
      <div
        class="relative px-2 border-b border-zinc-800/80 last:border-b-0 flex items-center transition-colors ${this.active ? "bg-blue-500/15" : "hover:bg-zinc-800/70"}"
        @contextmenu=${this.openContextMenu}
      >
        <button
          data-session-id=${s.id}
          class="absolute inset-0 cursor-pointer"
          aria-label="Open session: ${truncated}"
          @click=${this.handleClick}
          @keydown=${this.handleKeyDown}
        ></button>
        <div class="relative z-[1] pointer-events-none flex-1 min-w-0">
          <div class="min-w-0 flex-1">
            <div class="pt-2 flex min-w-0 items-center gap-1.5">
              <div class="min-w-0 flex-1 text-xs ${this.active ? "text-blue-300" : "text-zinc-300"} truncate">${truncated}</div>
              ${this.activityState ? html`
                <activity-dot class="relative z-[2] shrink-0 pointer-events-none" .state=${this.activityState}></activity-dot>
              ` : nothing}
            </div>
            <div class="flex items-center gap-1 pb-2 mt-0.5">
              <span class="h-4 flex items-center text-[10px] text-zinc-500">${date} · ${s.messageCount} messages</span>
              ${childCount > 0 ? html`
                <delegate-popover
                  class="relative z-[2] pointer-events-auto"
                  .childSessions=${this.childSessions}
                  .activeSessionId=${this.activeSessionId}
                  .onSetSessionUnread=${this.onSetSessionUnread}
                ></delegate-popover>
              ` : nothing}
            </div>
          </div>
        </div>
        ${this.contextMenu ? html`
          <div
            data-role="session-activity-menu"
            popover="manual"
            class="fixed inset-0 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-transparent p-0 z-[var(--layer-overlay)]"
            role="menu"
            aria-label="Session actions"
            @click=${this.closeContextMenu}
            @contextmenu=${(event: MouseEvent) => {
              event.preventDefault();
              this.closeContextMenu();
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Escape") this.closeContextMenu();
            }}
          >
            <div
              class="absolute w-40 overflow-hidden rounded-md border border-zinc-600 bg-zinc-800 shadow-xl"
              style=${styleMap(this.contextMenuPosition())}
              @click=${(event: Event) => event.stopPropagation()}
            >
              ${this.renderActivityActions()}
            </div>
          </div>
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
