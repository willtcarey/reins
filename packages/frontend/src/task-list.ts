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
import type { ActivityState } from "./activity-tracker.js";
import { formatRelativeDate } from "./format.js";

@customElement("task-list")
export class TaskList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @property({ attribute: false })
  tasks: TaskListItem[] = [];

  @property({ type: String })
  activeSessionId = "";

  /** Activity states for sessions (running/finished indicators). */
  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  @state() private expandedTaskId: number | null = null;
  @state() private taskSessions = new Map<number, SessionListItem[]>();
  @state() private deleteConfirmTask: TaskListItem | null = null;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("projectId")) {
      this.expandedTaskId = null;
      this.taskSessions = new Map();
    }
    if (changed.has("activeSessionId") || changed.has("tasks")) {
      this.autoExpandForActiveSession();
    }
  }

  /**
   * If the active session belongs to a task, expand that task.
   */
  private autoExpandForActiveSession() {
    if (!this.activeSessionId) return;
    const task = this.tasks.find(t => t.session_ids.includes(this.activeSessionId));
    if (task && task.id !== this.expandedTaskId) {
      this.expandedTaskId = task.id;
      this.fetchTaskSessions(task.id);
    }
  }

  /** Re-fetch sessions for the currently expanded task. */
  async refreshExpanded() {
    if (this.expandedTaskId != null) {
      await this.fetchTaskSessions(this.expandedTaskId);
    }
  }

  private async handleExpandTask(taskId: number) {
    if (this.expandedTaskId === taskId) {
      this.expandedTaskId = null;
      return;
    }
    this.expandedTaskId = taskId;
    await this.fetchTaskSessions(taskId);
  }

  private async fetchTaskSessions(taskId: number) {
    if (this.projectId == null) return;
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}/sessions`
      );
      if (resp.ok) {
        const sessions: SessionListItem[] = await resp.json();
        const next = new Map(this.taskSessions);
        next.set(taskId, sessions);
        this.taskSessions = next;
      }
    } catch {
      // silent
    }
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

  private handleEditTask(task: TaskListItem, e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("edit-task", {
        bubbles: true,
        composed: true,
        detail: { task },
      }),
    );
  }

  private handleDeleteTask(task: TaskListItem, e: Event) {
    e.stopPropagation();
    this.deleteConfirmTask = task;
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

    return html`
      <button
        class="w-full text-left px-3 py-2 border-b border-zinc-700/50 cursor-pointer transition-colors
          ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700/30"}"
        @click=${() => this.handleSelectSession(s.id)}
      >
        <div class="flex items-center gap-1.5">
          ${this.renderActivityDot(s.id)}
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

  private renderTask(task: TaskListItem) {
    const isExpanded = this.expandedTaskId === task.id;
    const sessions = this.taskSessions.get(task.id) ?? [];
    const date = formatRelativeDate(task.updated_at);

    return html`
      <div class="border-b border-zinc-700/50 group/task">
        <div class="flex items-start">
          <button
            class="flex-1 text-left px-3 py-2.5 cursor-pointer transition-colors hover:bg-zinc-700/30 flex items-start gap-2 min-w-0"
            @click=${() => this.handleExpandTask(task.id)}
          >
            <span class="text-zinc-500 text-[10px] mt-0.5 shrink-0">${isExpanded ? "▼" : "▶"}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <div class="text-xs text-zinc-200 truncate">${task.title}</div>
                ${this.renderTaskActivityDot(task.id)}
              </div>
              <div class="text-[10px] text-zinc-500 mt-0.5">
                ${date} · ${task.session_count} session${task.session_count !== 1 ? "s" : ""}
              </div>
            </div>
          </button>
          <button
            class="px-2 py-2.5 text-zinc-600 hover:text-zinc-300 md:opacity-0 md:group-hover/task:opacity-100 transition-all cursor-pointer shrink-0"
            title="Edit task"
            @click=${(e: Event) => this.handleEditTask(task, e)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>
          <button
            class="px-2 py-2.5 text-zinc-600 hover:text-red-400 md:opacity-0 md:group-hover/task:opacity-100 transition-all cursor-pointer shrink-0"
            title="Delete task"
            @click=${(e: Event) => this.handleDeleteTask(task, e)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
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

    return html`
      <div class="px-3 py-2 border-b border-zinc-700">
        <h2 class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">Tasks</h2>
      </div>
      ${this.tasks.map(t => this.renderTask(t))}
      ${this.renderDeleteDialog()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-list": TaskList;
  }
}
