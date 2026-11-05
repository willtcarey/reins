/**
 * Task List
 *
 * A project's open tasks, from the SDK. A task expands to show its sessions, which load the first time it
 * expands; the active session's task expands by itself. Dispatches events when a session is selected or a new
 * task session is requested.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ReinsSdk, Task } from "@reins/sdk";
import { deleteTaskEvent, newTaskEvent } from "../../../components/events.js";
import { plusIcon } from "../../../ui/icons.js";
import { SubscriptionsController } from "../../../controllers/subscriptions-controller.js";
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

  /** The SDK it reads tasks and sessions from. */
  @property({ attribute: false })
  reins: ReinsSdk | null = null;

  @property({ type: String })
  activeSessionId = "";

  @property({ attribute: false })
  disclosureState: TaskListDisclosureState = createTaskListDisclosureState();

  @state() private deleteConfirmTask: Task | null = null;

  constructor() {
    super();
    // Its project's tasks, and their sessions.
    const mine = ({ projectIds }: { projectIds: readonly (number | null)[] }) => {
      if (this.projectId != null && projectIds.includes(this.projectId)) this.requestUpdate();
    };
    new SubscriptionsController(this, () => this.reins, (reins) => [reins.tasks.onDidChange(mine), reins.sessions.onDidChange(mine)]);
  }

  override willUpdate(changed: Map<string, unknown>) {
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

  /** If the active session belongs to one of its tasks, expand that task. */
  private autoExpandForActiveSession() {
    if (!this.activeSessionId || this.projectId == null) return;
    const taskId = this.reins?.sessions.list({ projectId: this.projectId }).find((session) => session.id === this.activeSessionId)?.taskId;
    if (taskId != null) this.disclosureState.expandedTaskId = taskId;
  }

  private handleToggleExpand(e: CustomEvent<{ taskId: number }>) {
    const { taskId } = e.detail;
    this.disclosureState.expandedTaskId = this.disclosureState.expandedTaskId === taskId ? null : taskId;
    this.requestUpdate();
  }

  /** A task's Delete asks first; only the confirmed deletion goes on to the section. */
  private handleDeleteTask(e: CustomEvent<{ task: Task }>) {
    e.stopPropagation();
    this.deleteConfirmTask = e.detail.task;
  }

  private handleNewTask() {
    this.dispatchEvent(newTaskEvent(this.projectId));
  }

  /** Only the expanded task's sessions are asked for: asking loads them. */
  private renderTask(task: Task) {
    const expanded = this.disclosureState.expandedTaskId === task.id;
    const sessions = expanded && this.projectId != null ? this.reins?.sessions.list({ projectId: this.projectId, taskId: task.id }) ?? [] : [];
    return html`
      <task-list-item
        .task=${task}
        .expanded=${expanded}
        .sessions=${sessions}
        .activeSessionId=${this.activeSessionId}
        .projectId=${this.projectId}
        .sessionActions=${this.reins?.sessions ?? null}
        @toggle-expand=${this.handleToggleExpand}
        @delete-task=${this.handleDeleteTask}
      ></task-list-item>
    `;
  }

  override render() {
    const tasks = this.projectId == null ? [] : (this.reins?.tasks.list(this.projectId) ?? []).filter((task) => !task.closed);

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
