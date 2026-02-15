/**
 * Session Sidebar
 *
 * Task-oriented sidebar that lists tasks and scratch sessions for the current
 * project. Tasks can be expanded to show their sessions. Supports creating
 * tasks and sessions under tasks or as standalone scratch sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppClient, SessionListItem, SessionData, TaskListItem } from "./ws-client.js";
import type { AppShell } from "./app.js";
import "./project-sidebar.js";

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
  @state() private expandedTaskId: number | null = null;
  @state() private taskSessions = new Map<number, SessionListItem[]>();
  @state() private collapsed = window.matchMedia("(max-width: 768px)").matches;
  @state() private loading = false;

  // New task form
  @state() private showNewTaskForm = false;
  @state() private newTaskTitle = "";
  @state() private newTaskDescription = "";
  @state() private creatingTask = false;

  override connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("activeProjectId")) {
      this.tasks = [];
      this.sessions = [];
      this.taskSessions = new Map();
      this.expandedTaskId = null;
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

      // Refresh expanded task sessions
      if (this.expandedTaskId != null) {
        await this.fetchTaskSessions(this.expandedTaskId);
      }
    } catch {
      // Silently fail
    }
    this.loading = false;
  }

  private ensureActiveSession() {
    if (!this.activeSessionId) return;
    const found = this.sessions.some(s => s.id === this.activeSessionId);
    if (!found) {
      // Check task sessions too
      for (const [, sessions] of this.taskSessions) {
        if (sessions.some(s => s.id === this.activeSessionId)) return;
      }
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

  // ---- Task actions --------------------------------------------------------

  private async handleCreateTask() {
    if (this.activeProjectId == null || !this.newTaskTitle.trim()) return;
    this.creatingTask = true;
    try {
      const resp = await fetch(`/api/projects/${this.activeProjectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: this.newTaskTitle.trim(),
          description: this.newTaskDescription.trim() || undefined,
        }),
      });
      if (resp.ok) {
        this.newTaskTitle = "";
        this.newTaskDescription = "";
        this.showNewTaskForm = false;
        await this.refresh();
      } else {
        const data = await resp.json().catch(() => ({}));
        alert(data.error || `Error creating task (HTTP ${resp.status})`);
      }
    } catch {
      // silent
    }
    this.creatingTask = false;
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
    if (this.activeProjectId == null) return;
    try {
      const resp = await fetch(
        `/api/projects/${this.activeProjectId}/tasks/${taskId}/sessions`
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

  private async handleNewTaskSession(taskId: number) {
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
      await this.fetchTaskSessions(taskId);
      await this.refresh();
    } catch {
      // silent
    }
  }

  // ---- Session actions -----------------------------------------------------

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

  private async handleSelectSession(sessionId: string) {
    if (this.activeProjectId == null || !sessionId) return;
    try {
      const resp = await fetch(`/api/projects/${this.activeProjectId}/sessions/${encodeURIComponent(sessionId)}`);
      if (!resp.ok) return;
      const data: SessionData = await resp.json();
      this.notifyApp(data);
    } catch {
      // silent
    }
  }

  private notifyApp(data: SessionData) {
    const app = this.closest("app-shell") as AppShell | null;
    app?.loadSession(data);
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  // ---- Formatting ----------------------------------------------------------

  private formatRelativeDate(iso: string): string {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  // ---- Renderers -----------------------------------------------------------

  private renderSession(s: SessionListItem) {
    const isActive = s.id === this.activeSessionId;
    const label = s.name || s.first_message || "Empty session";
    const truncated = label.length > 60 ? label.slice(0, 60) + "..." : label;
    const date = this.formatRelativeDate(s.updated_at);

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
    const date = this.formatRelativeDate(task.updated_at);

    return html`
      <div class="border-b border-zinc-700/50">
        <!-- Task header -->
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

        <!-- Expanded: task sessions -->
        ${isExpanded ? html`
          <div class="pl-5 bg-zinc-800/30">
            ${sessions.length === 0
              ? html`<div class="px-3 py-2 text-[10px] text-zinc-500">No sessions yet</div>`
              : sessions.map(s => this.renderSession(s))}
            <div class="px-3 py-1.5">
              <button
                class="w-full py-1 text-[10px] text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${(e: Event) => { e.stopPropagation(); this.handleNewTaskSession(task.id); }}
              >
                + New Session
              </button>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderNewTaskForm() {
    if (!this.showNewTaskForm) return nothing;

    return html`
      <div class="p-2 border-b border-zinc-700 bg-zinc-800/50">
        <input
          type="text"
          class="w-full px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          placeholder="Task title"
          .value=${this.newTaskTitle}
          @input=${(e: Event) => this.newTaskTitle = (e.target as HTMLInputElement).value}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleCreateTask(); }
            if (e.key === "Escape") { this.showNewTaskForm = false; }
          }}
        />
        <textarea
          class="w-full mt-1.5 px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500 resize-none"
          rows="2"
          placeholder="Description (optional)"
          .value=${this.newTaskDescription}
          @input=${(e: Event) => this.newTaskDescription = (e.target as HTMLTextAreaElement).value}
        ></textarea>
        <div class="flex gap-1.5 mt-1.5">
          <button
            class="flex-1 py-1 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            @click=${this.handleCreateTask}
            ?disabled=${this.creatingTask || !this.newTaskTitle.trim()}
          >
            ${this.creatingTask ? "Creating..." : "Create Task"}
          </button>
          <button
            class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            @click=${() => { this.showNewTaskForm = false; }}
          >
            Cancel
          </button>
        </div>
      </div>
    `;
  }

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
      <div class="w-64 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col shrink-0">
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

        ${this.renderNewTaskForm()}

        <!-- Scrollable content -->
        <div class="flex-1 overflow-y-auto">
          ${this.loading ? html`
            <div class="p-3 text-xs text-zinc-500">Loading...</div>
          ` : html`
            <!-- Tasks section -->
            ${this.tasks.length > 0 ? html`
              <div class="px-3 py-2 border-b border-zinc-700">
                <h2 class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">Tasks</h2>
              </div>
              ${this.tasks.map(t => this.renderTask(t))}
            ` : nothing}

            <!-- Divider between tasks and scratch sessions -->
            ${this.tasks.length > 0 && this.sessions.length > 0 ? html`
              <div class="border-b border-zinc-600"></div>
            ` : nothing}

            <!-- Scratch sessions section -->
            <div class="px-3 py-2 border-b border-zinc-700 flex items-center justify-between">
              <h2 class="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">
                ${this.tasks.length > 0 ? "Scratch Sessions" : "Sessions"}
              </h2>
              <button
                class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${this.toggleCollapse}
                title="Hide sidebar"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
            </div>

            <div class="p-2 border-b border-zinc-700">
              <button
                class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
                @click=${this.handleNewSession}
              >
                + New Session
              </button>
            </div>

            ${this.sessions.length === 0 ? html`
              <div class="p-3 text-xs text-zinc-500">No sessions yet</div>
            ` : this.sessions.map(s => this.renderSession(s))}
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
