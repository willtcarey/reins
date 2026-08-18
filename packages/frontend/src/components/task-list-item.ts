/**
 * Task List Item
 *
 * Renders a single task row with expand/collapse, branch info, context menu,
 * and (when expanded) nested session list.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { springCollapse } from "../directives/spring-collapse.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import type { SessionListItem } from "../models/ws-client.js";
import type { TaskListItem } from "../models/tasks.js";
import type { ActivityState } from "../models/stores/session-cache.js";
import { formatRelativeDate } from "../models/format.js";
import { buildChildMap } from "./delegate-popover.js";
import {
  editTaskEvent,
  newTaskSessionEvent,
  requestDeleteTaskEvent,
  toggleTaskExpandEvent,
} from "./events.js";
import { branchIcon, plusIcon } from "./icons.js";
import "./activity-dot.js";
import "./popover-menu.js";
import "./session-list-item.js";

@customElement("task-list-item")
export class TaskListItemElement extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  task!: TaskListItem;

  @property({ type: Boolean })
  expanded = false;

  @property({ attribute: false })
  sessions: SessionListItem[] = [];

  @property({ type: String })
  activeSessionId = "";

  @property({ attribute: false })
  activityState: ActivityState | undefined = undefined;

  @property({ type: Number })
  projectId: number | null = null;

  private handleExpand() {
    this.dispatchEvent(toggleTaskExpandEvent(this.task.id));
  }

  private handleNewTaskSession(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(newTaskSessionEvent(this.projectId, this.task.id));
  }

  private handleEditTask() {
    this.dispatchEvent(editTaskEvent(this.projectId, this.task));
  }

  private handleDeleteTask() {
    this.dispatchEvent(requestDeleteTaskEvent(this.task));
  }

  private handleCopyBranchName() {
    copyTextToClipboard(this.task.branch_name).catch(() => {});
  }

  private renderActivityDot() {
    return html`<activity-dot .state=${this.activityState}></activity-dot>`;
  }

  private renderBranchInfo() {
    const task = this.task;
    if (task.status === "closed") return nothing;

    const stats = task.diffStats;
    return html`
      <div class="flex items-center gap-1.5 mt-0.5">
        ${branchIcon("shrink-0 text-zinc-500", 10)}
        <span class="text-[10px] font-mono text-zinc-500 truncate">${task.branch_name}</span>
        ${stats && (stats.additions > 0 || stats.removals > 0) ? html`
          <span class="text-[10px] shrink-0">
            ${stats.additions > 0 ? html`<span class="text-green-500">+${stats.additions}</span>` : nothing}
            ${stats.additions > 0 && stats.removals > 0 ? html`<span class="text-zinc-600"> </span>` : nothing}
            ${stats.removals > 0 ? html`<span class="text-red-400">-${stats.removals}</span>` : nothing}
          </span>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    const task = this.task;
    const isExpanded = this.expanded;
    const sessions = this.sessions;
    const date = formatRelativeDate(task.updated_at);
    const isClosed = task.status === "closed";
    return html`
      <div class="px-1 pb-1 group/task ${isClosed ? "opacity-50" : ""}">
        <div class="flex items-start rounded-md transition-colors hover:bg-zinc-800/70">
          <button
            class="flex-1 text-left px-3 py-2.5 cursor-pointer flex items-start gap-2 min-w-0"
            @click=${() => this.handleExpand()}
          >
            <span class="text-zinc-500 text-[10px] mt-0.5 shrink-0">${isClosed ? "✓" : isExpanded ? "▼" : "▶"}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <div class="text-xs ${isClosed ? "text-zinc-400" : "text-zinc-200"} truncate">${task.title}</div>
                ${this.renderActivityDot()}
              </div>
              ${this.renderBranchInfo()}
              <div class="text-[10px] text-zinc-500 mt-0.5">
                ${date} · ${task.session_count} session${task.session_count !== 1 ? "s" : ""}
              </div>
            </div>
          </button>
          <button
            class="px-1.5 py-2.5 text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors shrink-0"
            title="New session"
            @click=${(e: Event) => this.handleNewTaskSession(e)}
          >
            ${plusIcon()}
          </button>
          <popover-menu
            close-on-panel-click
            .content=${() => html`
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleEditTask()}
              >Edit</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleCopyBranchName()}
              >Copy branch</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleDeleteTask()}
              >Delete</button>
            `}
          ></popover-menu>
        </div>

        ${springCollapse(!isExpanded, () => sessions.length > 0 ? html`
          <div class="mx-2 mt-1 mb-1 rounded-md border border-zinc-800/80 bg-zinc-950/30 overflow-hidden">
            ${(() => {
              const childMap = buildChildMap(sessions);
              const topLevel = sessions.filter(s => !s.parentSessionId);
              return topLevel.map(s => html`
                <session-list-item
                  .session=${s}
                  .active=${s.id === this.activeSessionId}
                  .activityState=${s.activityState}
                  .childSessions=${childMap.get(s.id) ?? []}
                  .activeSessionId=${this.activeSessionId}
                  .projectId=${this.projectId}
                ></session-list-item>
              `);
            })()}
          </div>
        ` : task.session_count > 0 ? html`
          <div class="mx-2 mt-1 mb-1 rounded-md border border-zinc-800/80 bg-zinc-950/30 overflow-hidden">
            <div class="px-3 py-2 text-[10px] text-zinc-500">Loading…</div>
          </div>
        ` : nothing)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-list-item": TaskListItemElement;
  }
}
