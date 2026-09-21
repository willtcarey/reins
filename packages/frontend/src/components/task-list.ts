/**
 * Task List
 *
 * Renders the list of tasks for a project. Each task can be expanded to show
 * its sessions. Dispatches events when a session is selected or a new task
 * session is requested.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { TaskWithDiffStats as TaskListItem } from "@backend/models/tasks.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import { deleteTaskEvent, newTaskEvent } from "./events.js";
import { plusIcon } from "../ui/icons.js";
import "./delete-task-dialog.js";
import "./task-list-item.js";

export interface TaskListDisclosureState {
  expandedTaskId: number | null;
  activeSessionId: string;
}

export function createTaskListDisclosureState(): TaskListDisclosureState {
  return {
    expandedTaskId: null,
    activeSessionId: "",
  };
}

@customElement("task-list")
export class TaskList extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @property({ attribute: false })
  projectStore: ProjectStore | null = null;

  @property({ type: String })
  activeSessionId = "";

  @property({ attribute: false })
  disclosureState: TaskListDisclosureState = createTaskListDisclosureState();

  @state() private deleteConfirmTask: TaskListItem | null = null;

  private _projectStoreUnsubscribe: (() => void) | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._projectStoreUnsubscribe?.();
    this._projectStoreUnsubscribe = null;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("projectStore")) {
      this._subscribeToProjectStore();
    }
    if (changed.has("projectId") && changed.get("projectId") != null) {
      this.disclosureState.expandedTaskId = null;
    }
    if (
      changed.has("activeSessionId")
      && this.disclosureState.activeSessionId !== this.activeSessionId
    ) {
      this.disclosureState.activeSessionId = this.activeSessionId;
      this.autoExpandForActiveSession();
    }
  }

  private _subscribeToProjectStore() {
    this._projectStoreUnsubscribe?.();
    this._projectStoreUnsubscribe = this.projectStore?.subscribe(() => {
      this.requestUpdate();
    }) ?? null;
  }

  /**
   * If the active session belongs to a task, expand that task and fetch its sessions.
   */
  private autoExpandForActiveSession() {
    if (!this.activeSessionId) return;
    const taskId = this.projectStore?.getSession(this.activeSessionId)?.taskId;
    if (taskId != null && taskId !== this.disclosureState.expandedTaskId) {
      this.disclosureState.expandedTaskId = taskId;
      this.projectStore?.fetchTaskSessions(taskId);
    }
  }

  /** Re-fetch sessions for the currently expanded task. */
  refreshExpanded() {
    if (this.disclosureState.expandedTaskId != null) {
      this.projectStore?.fetchTaskSessions(this.disclosureState.expandedTaskId);
    }
  }

  private handleToggleExpand(e: CustomEvent<{ taskId: number }>) {
    const { taskId } = e.detail;
    if (this.disclosureState.expandedTaskId === taskId) {
      this.disclosureState.expandedTaskId = null;
    } else {
      this.disclosureState.expandedTaskId = taskId;
      this.projectStore?.fetchTaskSessions(taskId);
    }
    this.requestUpdate();
  }

  private handleDeleteTask(e: CustomEvent<{ task: TaskListItem }>) {
    this.deleteConfirmTask = e.detail.task;
  }

  private handleNewTask() {
    this.dispatchEvent(newTaskEvent(this.projectId));
  }

  private setSessionUnread(sessionId: string, unread: boolean): Promise<unknown> {
    return this.projectStore?.setSessionUnread(sessionId, unread)
      ?? Promise.resolve({ error: "Project is unavailable" });
  }

  private updateSessionMetadata(
    sessionId: string,
    updates: { name?: string | null; pinned?: boolean; archived?: boolean },
  ): Promise<unknown> {
    return this.projectStore?.updateSessionMetadata(sessionId, updates)
      ?? Promise.resolve({ error: "Project is unavailable" });
  }

  private renderTask(task: TaskListItem) {
    return html`
      <task-list-item
        .task=${task}
        .expanded=${this.disclosureState.expandedTaskId === task.id}
        .sessions=${this.projectStore?.taskSessionsFor(task.id) ?? []}
        .activeSessionId=${this.activeSessionId}
        .activityState=${this.projectStore?.activityForTask(task.id)}
        .projectId=${this.projectId}
        .onSetSessionUnread=${(sessionId: string, unread: boolean) => this.setSessionUnread(sessionId, unread)}
        .onUpdateMetadata=${(sessionId: string, updates: { name?: string | null; pinned?: boolean; archived?: boolean }) => this.updateSessionMetadata(sessionId, updates)}
        @toggle-expand=${this.handleToggleExpand}
        @delete-task=${this.handleDeleteTask}
      ></task-list-item>
    `;
  }

  override render() {
    const tasks = this.projectStore?.tasks.filter((task) => task.status !== "closed") ?? [];

    return html`
      <div class="flex items-center px-3 pt-3 pb-1">
        <h2 class="flex-1 text-[9px] font-semibold text-zinc-600 uppercase tracking-wider">Tasks</h2>
        <button
          class="p-0.5 text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors shrink-0"
          @click=${this.handleNewTask}
          title="New task"
        >
          ${plusIcon("", 10)}
        </button>
      </div>
      ${tasks.map(task => this.renderTask(task))}
      <delete-task-dialog
        .task=${this.deleteConfirmTask}
        @cancel-delete=${() => {
          this.deleteConfirmTask = null;
        }}
        @confirm-delete=${(e: CustomEvent) => {
          const taskId = e.detail.taskId;
          this.deleteConfirmTask = null;
          if (this.disclosureState.expandedTaskId === taskId) {
            this.disclosureState.expandedTaskId = null;
          }
          this.requestUpdate();
          this.dispatchEvent(deleteTaskEvent(this.projectId, taskId));
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
