/**
 * Task List
 *
 * Renders the list of tasks for a project. Each task can be expanded to show
 * its sessions. Dispatches events when a session is selected or a new task
 * session is requested.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionListItem } from "../models/ws-client.js";
import { TasksCollection, type TaskListItem } from "../models/tasks.js";
import type { ActivityState } from "../models/stores/activity-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import "./delete-task-dialog.js";
import "./task-list-item.js";

@customElement("task-list")
export class TaskList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @property({ attribute: false })
  projectStore: ProjectStore | null = null;

  @property({ attribute: false })
  tasksCollection: TasksCollection = TasksCollection.empty();

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
    if (changed.has("activeSessionId") || changed.has("tasksCollection")) {
      this.autoExpandForActiveSession();
    }
  }

  /**
   * If the active session belongs to a task, expand that task and fetch its sessions.
   */
  private autoExpandForActiveSession() {
    if (!this.activeSessionId) return;
    const task = this.tasksCollection.findBySessionId(this.activeSessionId);
    if (task && task.id !== this.expandedTaskId) {
      this.expandedTaskId = task.id;
      this.projectStore?.fetchTaskSessions(task.id);
    }
  }

  /** Re-fetch sessions for the currently expanded task. */
  refreshExpanded() {
    if (this.expandedTaskId != null) {
      this.projectStore?.fetchTaskSessions(this.expandedTaskId);
    }
  }

  private handleToggleExpand(e: CustomEvent<{ taskId: number }>) {
    const { taskId } = e.detail;
    if (this.expandedTaskId === taskId) {
      this.expandedTaskId = null;
      return;
    }
    this.expandedTaskId = taskId;
    this.projectStore?.fetchTaskSessions(taskId);
  }

  private handleDeleteTask(e: CustomEvent<{ task: TaskListItem }>) {
    this.deleteConfirmTask = e.detail.task;
  }

  private handleNewTask() {
    this.dispatchEvent(
      new CustomEvent("new-task", {
        bubbles: true,
        composed: true,
        detail: { projectId: this.projectId },
      })
    );
  }

  private renderTask(task: TaskListItem) {
    return html`
      <task-list-item
        .task=${task}
        .expanded=${this.expandedTaskId === task.id}
        .sessions=${this.taskSessions.get(task.id) ?? []}
        .activeSessionId=${this.activeSessionId}
        .activityState=${this.tasksCollection.activityFor(task)}
        .activityMap=${this.activityMap}
        .projectId=${this.projectId}
        @toggle-expand=${this.handleToggleExpand}
        @delete-task=${this.handleDeleteTask}
      ></task-list-item>
    `;
  }

  override render() {
    const openTasks = this.tasksCollection.open;
    const closedTasks = this.tasksCollection.closed;

    return html`
      <div class="flex items-center px-3 pt-3 pb-1">
        <h2 class="flex-1 text-[9px] font-semibold text-zinc-600 uppercase tracking-wider">Tasks</h2>
        <button
          class="p-0.5 text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors shrink-0"
          @click=${this.handleNewTask}
          title="New task"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
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
      <delete-task-dialog
        .task=${this.deleteConfirmTask}
        @cancel-delete=${() => { this.deleteConfirmTask = null; }}
        @confirm-delete=${(e: CustomEvent) => {
          const taskId = e.detail.taskId;
          this.deleteConfirmTask = null;
          if (this.expandedTaskId === taskId) this.expandedTaskId = null;
          this.dispatchEvent(new CustomEvent("delete-task", { bubbles: true, composed: true, detail: { projectId: this.projectId, taskId } }));
        }}
      ></delete-task-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-list": TaskList;
  }
}
