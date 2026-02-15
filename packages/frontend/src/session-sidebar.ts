/**
 * Session Sidebar
 *
 * Orchestrator component that composes the sidebar from:
 *  - project-sidebar  — project switcher
 *  - task-form        — new task creation
 *  - task-list        — task listing with expandable sessions
 *  - session-list     — scratch session listing
 *
 * Owns the data-fetching and coordinates child components via
 * properties (down) and events (up).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppClient, SessionListItem, SessionData, TaskListItem } from "./ws-client.js";
import type { AppShell } from "./app.js";
import type { TaskList } from "./task-list.js";
import "./project-sidebar.js";
import "./task-form.js";
import "./task-list.js";
import "./session-list.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  client: AppClient | null = null;

  @property({ type: String })
  activeSessionId = "";

  /** Current project ID from the URL route. Null = no project selected. */
  @property({ type: Number })
  activeProjectId: number | null = null;

  @state() private tasks: TaskListItem[] = [];
  @state() private sessions: SessionListItem[] = []; // scratch sessions only
  @state() private collapsed = window.matchMedia("(max-width: 768px)").matches;
  @state() private loading = false;
  @state() private showNewTaskForm = false;

  override connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("activeProjectId")) {
      this.tasks = [];
      this.sessions = [];
      this.showNewTaskForm = false;
      this.refresh();
    }
    if (changed.has("activeSessionId") && this.activeSessionId) {
      this.ensureActiveSession();
    }
  }

  /** Accept a pre-fetched session list (avoids a redundant fetch). */
  setSessionList(sessions: SessionListItem[]) {
    this.sessions = sessions;
    this.loading = false;
    this.ensureActiveSession();
  }

  async refresh() {
    if (this.activeProjectId == null) {
      this.tasks = [];
      this.sessions = [];
      return;
    }
    this.loading = true;
    try {
      const [tasksResp, sessionsResp] = await Promise.all([
        fetch(`/api/projects/${this.activeProjectId}/tasks`),
        fetch(`/api/projects/${this.activeProjectId}/sessions`),
      ]);
      if (tasksResp.ok) this.tasks = await tasksResp.json();
      if (sessionsResp.ok) {
        this.sessions = await sessionsResp.json();
        this.ensureActiveSession();
      }

      // Refresh expanded task sessions in the child
      this.getTaskList()?.refreshExpanded();
    } catch {
      // Silently fail
    }
    this.loading = false;
  }

  private getTaskList(): TaskList | null {
    return this.querySelector("task-list") as TaskList | null;
  }

  private ensureActiveSession() {
    if (!this.activeSessionId) return;
    const found = this.sessions.some(s => s.id === this.activeSessionId);
    if (!found) {
      // Check task sessions too
      if (this.getTaskList()?.hasSession(this.activeSessionId)) return;
      // Add stub entry for scratch sessions
      this.sessions = [
        {
          id: this.activeSessionId,
          name: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          message_count: 0,
          first_message: null,
        },
        ...this.sessions,
      ];
    }
  }

  // ---- Event handlers from child components --------------------------------

  private async handleSelectSession(e: CustomEvent<{ sessionId: string }>) {
    const sessionId = e.detail.sessionId;
    if (this.activeProjectId == null || !sessionId) return;
    try {
      const resp = await fetch(
        `/api/projects/${this.activeProjectId}/sessions/${encodeURIComponent(sessionId)}`
      );
      if (!resp.ok) return;
      const data: SessionData = await resp.json();
      this.notifyApp(data);
    } catch {
      // silent
    }
  }

  private async handleNewSession() {
    if (this.activeProjectId == null) return;
    try {
      const resp = await fetch(`/api/projects/${this.activeProjectId}/sessions`, { method: "POST" });
      if (!resp.ok) return;
      const data: SessionData = await resp.json();
      this.notifyApp(data);
    } catch {
      // silent
    }
  }

  private async handleNewTaskSession(e: CustomEvent<{ taskId: number }>) {
    const taskId = e.detail.taskId;
    if (this.activeProjectId == null) return;
    try {
      const resp = await fetch(
        `/api/projects/${this.activeProjectId}/tasks/${taskId}/sessions`,
        { method: "POST" }
      );
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(data.error || `Error creating session (HTTP ${resp.status})`);
        return;
      }
      const data: SessionData = await resp.json();
      this.notifyApp(data);
      await this.refresh();
    } catch {
      // silent
    }
  }

  private async handleTaskCreated() {
    this.showNewTaskForm = false;
    await this.refresh();
  }

  private notifyApp(data: SessionData) {
    const app = this.closest("app-shell") as AppShell | null;
    app?.loadSession(data);
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  // ---- Render --------------------------------------------------------------

  override render() {
    if (this.collapsed) {
      return html`
        <div class="w-10 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col items-center pt-2 shrink-0">
          <button
            class="p-1.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            @click=${this.toggleCollapse}
            title="Show sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      `;
    }

    return html`
      <div
        class="w-64 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col shrink-0"
        @select-session=${this.handleSelectSession}
        @new-session=${this.handleNewSession}
        @new-task-session=${this.handleNewTaskSession}
        @task-created=${this.handleTaskCreated}
        @task-cancelled=${() => { this.showNewTaskForm = false; }}
        @toggle-collapse=${this.toggleCollapse}
      >
        <!-- Project switcher -->
        <project-sidebar
          .activeProjectId=${this.activeProjectId}
        ></project-sidebar>

        <!-- New Task button -->
        <div class="p-2 border-b border-zinc-700">
          <button
            class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
            @click=${() => { this.showNewTaskForm = !this.showNewTaskForm; }}
          >
            + New Task
          </button>
        </div>

        ${this.showNewTaskForm ? html`
          <task-form .projectId=${this.activeProjectId}></task-form>
        ` : nothing}

        <!-- Scrollable content -->
        <div class="flex-1 overflow-y-auto">
          ${this.loading ? html`
            <div class="p-3 text-xs text-zinc-500">Loading...</div>
          ` : html`
            <task-list
              .projectId=${this.activeProjectId}
              .tasks=${this.tasks}
              .activeSessionId=${this.activeSessionId}
            ></task-list>

            <session-list
              .sessions=${this.sessions}
              .activeSessionId=${this.activeSessionId}
              .hasTasks=${this.tasks.length > 0}
            ></session-list>
          `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-sidebar": SessionSidebar;
  }
}
