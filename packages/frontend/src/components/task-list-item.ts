/**
 * Task List Item
 *
 * Renders a single task row with expand/collapse, branch info, context menu,
 * and (when expanded) nested session list.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionListItem } from "../models/ws-client.js";
import type { TaskListItem } from "../models/tasks.js";
import type { ActivityState } from "../models/stores/activity-store.js";
import { formatRelativeDate } from "../models/format.js";
import { buildChildMap } from "./delegate-popover.js";
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

  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  @property({ type: Number })
  projectId: number | null = null;

  private handleExpand() {
    this.dispatchEvent(
      new CustomEvent("toggle-expand", {
        bubbles: true,
        composed: true,
        detail: { taskId: this.task.id },
      }),
    );
  }

  private handleNewTaskSession(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("new-task-session", {
        bubbles: true,
        composed: true,
        detail: { projectId: this.projectId, taskId: this.task.id },
      }),
    );
  }

  private handleEditTask() {
    this.dispatchEvent(
      new CustomEvent("edit-task", {
        bubbles: true,
        composed: true,
        detail: { projectId: this.projectId, task: this.task },
      }),
    );
  }

  private handleDeleteTask() {
    this.dispatchEvent(
      new CustomEvent("delete-task", {
        bubbles: true,
        composed: true,
        detail: { task: this.task },
      }),
    );
  }

  private handleCopyBranchName() {
    navigator.clipboard.writeText(this.task.branch_name).catch(() => {});
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
        <svg class="shrink-0 text-zinc-500" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
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

  private isTaskActive(): boolean {
    if (!this.activeSessionId) return false;
    return this.task.session_ids.includes(this.activeSessionId);
  }

  override render() {
    const task = this.task;
    const isExpanded = this.expanded;
    const sessions = this.sessions;
    const date = formatRelativeDate(task.updated_at);
    const isClosed = task.status === "closed";
    const isActive = this.isTaskActive();

    return html`
      <div class="border-b border-zinc-700/50 group/task ${isClosed ? "opacity-50" : ""}">
        <div class="flex items-start transition-colors ${isActive && !isExpanded ? "bg-blue-500/15" : "hover:bg-zinc-700/30"}">
          <button
            class="flex-1 text-left px-3 py-2.5 cursor-pointer flex items-start gap-2 min-w-0"
            @click=${() => this.handleExpand()}
          >
            <span class="text-zinc-500 text-[10px] mt-0.5 shrink-0">${isClosed ? "✓" : isExpanded ? "▼" : "▶"}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <div class="text-xs ${isClosed ? "text-zinc-400" : isActive && !isExpanded ? "text-blue-300" : "text-zinc-200"} truncate">${task.title}</div>
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
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
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

        <div class="grid transition-[grid-template-rows] duration-200 ease-out ${isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}">
          <div class="overflow-hidden">
            ${sessions.length > 0 ? html`
              <div class="border-l border-zinc-600/30 ml-3">
                ${(() => {
                  const childMap = buildChildMap(sessions);
                  const topLevel = sessions.filter(s => !s.parent_session_id);
                  return topLevel.map(s => html`
                    <session-list-item
                      .session=${s}
                      .active=${s.id === this.activeSessionId}
                      .activityState=${this.activityMap.get(s.id)}
                      .childSessions=${childMap.get(s.id) ?? []}
                      .activityMap=${this.activityMap}
                      .activeSessionId=${this.activeSessionId}
                      .projectId=${this.projectId}
                    ></session-list-item>
                  `);
                })()}
              </div>
            ` : isExpanded && task.session_count > 0 ? html`
              <div class="border-l border-zinc-600/30 ml-3">
                <div class="px-3 py-2 text-[10px] text-zinc-500">Loading…</div>
              </div>
            ` : nothing}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-list-item": TaskListItemElement;
  }
}
