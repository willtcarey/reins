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

  @state() private expandedTaskId: number | null = null;
  @state() private taskSessions = new Map<number, SessionListItem[]>();

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("projectId")) {
      this.expandedTaskId = null;
      this.taskSessions = new Map();
    }
  }

  /** Re-fetch sessions for the currently expanded task. */
  async refreshExpanded() {
    if (this.expandedTaskId != null) {
      await this.fetchTaskSessions(this.expandedTaskId);
    }
  }

  /** Check whether a session ID exists inside any expanded task sessions. */
  hasSession(sessionId: string): boolean {
    for (const [, sessions] of this.taskSessions) {
      if (sessions.some(s => s.id === sessionId)) return true;
    }
    return false;
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

  private handleSelectSession(sessionId: string) {
    this.dispatchEvent(
      new CustomEvent("select-session", {
        bubbles: true,
        composed: true,
        detail: { sessionId },
      })
    );
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
        <div class="text-xs ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${truncated}</div>
        <div class="text-[10px] text-zinc-500 mt-0.5">${date} · ${s.message_count} messages</div>
      </button>
    `;
  }

  private renderTask(task: TaskListItem) {
    const isExpanded = this.expandedTaskId === task.id;
    const sessions = this.taskSessions.get(task.id) ?? [];
    const date = formatRelativeDate(task.updated_at);

    return html`
      <div class="border-b border-zinc-700/50">
        <button
          class="w-full text-left px-3 py-2.5 cursor-pointer transition-colors hover:bg-zinc-700/30 flex items-start gap-2"
          @click=${() => this.handleExpandTask(task.id)}
        >
          <span class="text-zinc-500 text-[10px] mt-0.5 shrink-0">${isExpanded ? "▼" : "▶"}</span>
          <div class="flex-1 min-w-0">
            <div class="text-xs text-zinc-200 truncate">${task.title}</div>
            <div class="text-[10px] text-zinc-500 mt-0.5">
              ${date} · ${task.session_count} session${task.session_count !== 1 ? "s" : ""}
            </div>
          </div>
        </button>

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

  override render() {
    if (this.tasks.length === 0) return nothing;

    return html`
      <div class="px-3 py-2 border-b border-zinc-700">
        <h2 class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">Tasks</h2>
      </div>
      ${this.tasks.map(t => this.renderTask(t))}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-list": TaskList;
  }
}
