/**
 * Task List
 *
 * Renders the list of tasks for a project. Each task can be expanded to show
 * its sessions. Dispatches events when a session is selected or a new task
 * session is requested.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionListItem, TaskListItem } from "./ws-client.js";
import type { AppStore } from "./stores/app-store.js";
import type { ActivityState } from "./stores/app-store.js";
import { formatRelativeDate } from "./format.js";
import "./popover-menu.js";

@customElement("task-list")
export class TaskList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @property({ attribute: false })
  store: AppStore | null = null;

  @property({ attribute: false })
  tasks: TaskListItem[] = [];

  @property({ type: String })
  activeSessionId = "";

  /** Activity states for sessions (running/finished indicators). */
  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  @property({ attribute: false })
  taskSessions = new Map<number, SessionListItem[]>();

  @state() private expandedTaskId: number | null = null;
  @state() private deleteConfirmTask: TaskListItem | null = null;
  @state() private closedExpanded = false;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("projectId")) {
      this.expandedTaskId = null;
    }
    if (changed.has("activeSessionId") || changed.has("tasks")) {
      this.autoExpandForActiveSession();
    }
  }

  /**
   * If the active session belongs to a task, expand that task and fetch its sessions.
   */
  private autoExpandForActiveSession() {
    if (!this.activeSessionId) return;
    const task = this.tasks.find(t => t.session_ids.includes(this.activeSessionId));
    if (task && task.id !== this.expandedTaskId) {
      this.expandedTaskId = task.id;
      this.store?.fetchTaskSessions(task.id);
    }
  }

  /** Re-fetch sessions for the currently expanded task. */
  refreshExpanded() {
    if (this.expandedTaskId != null) {
      this.store?.fetchTaskSessions(this.expandedTaskId);
    }
  }

  private handleExpandTask(taskId: number) {
    if (this.expandedTaskId === taskId) {
      this.expandedTaskId = null;
      return;
    }
    this.expandedTaskId = taskId;
    this.store?.fetchTaskSessions(taskId);
  }

  private handleNewTaskSession(taskId: number, e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("new-task-session", {
        bubbles: true,
        composed: true,
        detail: { taskId },
      })
    );
  }

  private handleEditTask(task: TaskListItem) {
    this.dispatchEvent(
      new CustomEvent("edit-task", {
        bubbles: true,
        composed: true,
        detail: { task },
      }),
    );
  }

  private handleDeleteTask(task: TaskListItem) {
    this.deleteConfirmTask = task;
  }

  private handleCopyBranchName(task: TaskListItem) {
    navigator.clipboard.writeText(task.branch_name).catch(() => {});
  }

  private handleCancelDelete() {
    this.deleteConfirmTask = null;
  }

  private handleConfirmDelete() {
    const task = this.deleteConfirmTask;
    if (!task) return;

    this.deleteConfirmTask = null;
    if (this.expandedTaskId === task.id) {
      this.expandedTaskId = null;
    }
    this.dispatchEvent(
      new CustomEvent("delete-task", {
        bubbles: true,
        composed: true,
        detail: { taskId: task.id },
      }),
    );
  }

  private handleSelectSession(sessionId: string) {
    this.dispatchEvent(
      new CustomEvent("select-session", {
        bubbles: true,
        composed: true,
        detail: { sessionId },
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

  /** Check if any session within a task has activity. */
  private getTaskActivity(taskId: number): ActivityState | undefined {
    const sessions = this.taskSessions.get(taskId);
    if (!sessions) return undefined;
    let hasFinished = false;
    for (const s of sessions) {
      const state = this.activityMap.get(s.id);
      if (state === "running") return "running";
      if (state === "finished") hasFinished = true;
    }
    return hasFinished ? "finished" : undefined;
  }

  private renderSession(s: SessionListItem) {
    const isActive = s.id === this.activeSessionId;
    const label = s.name || s.first_message || "Empty session";
    const truncated = label.length > 60 ? label.slice(0, 60) + "..." : label;
    const date = formatRelativeDate(s.updated_at);
    const isDelegated = !!s.parent_session_id;

    return html`
      <button
        class="w-full text-left px-3 py-2 border-b border-zinc-700/50 cursor-pointer transition-colors
          ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700/30"}"
        @click=${() => this.handleSelectSession(s.id)}
      >
        <div class="flex items-center gap-1.5">
          ${this.renderActivityDot(s.id)}
          ${isDelegated ? html`<span class="text-[9px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-400 shrink-0">sub</span>` : nothing}
          <div class="text-xs ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${truncated}</div>
        </div>
        <div class="text-[10px] text-zinc-500 mt-0.5">${date} · ${s.message_count} messages</div>
      </button>
    `;
  }

  private renderTaskActivityDot(taskId: number) {
    const state = this.getTaskActivity(taskId);
    if (!state) return nothing;
    const classes = state === "running"
      ? "w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
      : "w-2 h-2 rounded-full bg-amber-500 shrink-0";
    return html`<span class="${classes}"></span>`;
  }

  private renderBranchInfo(task: TaskListItem) {
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

  private renderTask(task: TaskListItem) {
    const isExpanded = this.expandedTaskId === task.id;
    const sessions = this.taskSessions.get(task.id) ?? [];
    const date = formatRelativeDate(task.updated_at);
    const isClosed = task.status === "closed";

    return html`
      <div class="border-b border-zinc-700/50 group/task ${isClosed ? "opacity-50" : ""}">
        <div class="flex items-start transition-colors hover:bg-zinc-700/30">
          <button
            class="flex-1 text-left px-3 py-2.5 cursor-pointer flex items-start gap-2 min-w-0"
            @click=${() => this.handleExpandTask(task.id)}
          >
            <span class="text-zinc-500 text-[10px] mt-0.5 shrink-0">${isClosed ? "✓" : isExpanded ? "▼" : "▶"}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <div class="text-xs ${isClosed ? "text-zinc-400" : "text-zinc-200"} truncate">${task.title}</div>
                ${this.renderTaskActivityDot(task.id)}
              </div>
              ${this.renderBranchInfo(task)}
              <div class="text-[10px] text-zinc-500 mt-0.5">
                ${date} · ${task.session_count} session${task.session_count !== 1 ? "s" : ""}
              </div>
            </div>
          </button>
          <popover-menu
            triggerClass="md:opacity-0 md:group-hover/task:opacity-100"
            .content=${() => html`
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleEditTask(task)}
              >Edit</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleCopyBranchName(task)}
              >Copy branch</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleDeleteTask(task)}
              >Delete</button>
            `}
          ></popover-menu>
        </div>

        ${isExpanded ? html`
          <div class="pl-5 bg-zinc-800/30">
            ${sessions.length === 0
              ? html`<div class="px-3 py-2 text-[10px] text-zinc-500">No sessions yet</div>`
              : sessions.map(s => this.renderSession(s))}
            <div class="px-3 py-1.5">
              <button
                class="w-full py-1 text-[10px] text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${(e: Event) => this.handleNewTaskSession(task.id, e)}
              >
                + New Session
              </button>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderDeleteDialog() {
    const task = this.deleteConfirmTask;
    if (!task) return nothing;

    return html`
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        @click=${this.handleCancelDelete}
      >
        <div
          class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl max-w-sm w-full mx-4 p-5"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <h3 class="text-sm font-semibold text-zinc-100 mb-3">Delete Task</h3>
          <p class="text-xs text-zinc-300 mb-1">
            Are you sure you want to delete this task?
          </p>
          <div class="bg-zinc-900 rounded px-3 py-2 mb-3">
            <div class="text-xs text-zinc-200 font-medium">${task.title}</div>
            ${task.description ? html`<div class="text-[11px] text-zinc-400 mt-1">${task.description}</div>` : nothing}
            <div class="text-[10px] text-zinc-500 mt-1.5">
              Branch: <span class="text-zinc-400 font-mono">${task.branch_name}</span>
              · ${task.session_count} session${task.session_count !== 1 ? "s" : ""}
            </div>
          </div>
          <p class="text-[11px] text-zinc-400 mb-4">
            This will permanently delete the task, all its sessions, and the git branch
            <span class="font-mono text-zinc-300">${task.branch_name}</span>.
          </p>
          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
              @click=${this.handleCancelDelete}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 rounded cursor-pointer transition-colors"
              @click=${this.handleConfirmDelete}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    if (this.tasks.length === 0 && !this.deleteConfirmTask) return nothing;

    const openTasks = this.tasks.filter(t => t.status !== "closed");
    const closedTasks = this.tasks.filter(t => t.status === "closed");

    return html`
      <div class="px-3 py-2 border-b border-zinc-700">
        <h2 class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">Tasks</h2>
      </div>
      ${openTasks.map(t => this.renderTask(t))}
      ${closedTasks.length > 0 ? html`
        <div class="border-b border-zinc-700">
          <button
            class="w-full px-3 py-1.5 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-400 cursor-pointer transition-colors"
            @click=${() => { this.closedExpanded = !this.closedExpanded; }}
          >
            <span class="font-mono">${this.closedExpanded ? "▼" : "▶"}</span>
            <span class="uppercase tracking-wide font-semibold">Completed tasks</span>
            <span class="text-zinc-600">(${closedTasks.length})</span>
          </button>
          ${this.closedExpanded ? closedTasks.map(t => this.renderTask(t)) : nothing}
        </div>
      ` : nothing}
      ${this.renderDeleteDialog()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-list": TaskList;
  }
}
