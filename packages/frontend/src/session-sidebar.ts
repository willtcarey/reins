/**
 * Session Sidebar
 *
 * Orchestrator component that composes the sidebar from:
 *  - project-sidebar  — project switcher
 *  - task-form        — new task creation
 *  - task-list        — task listing with expandable sessions
 *  - session-list     — scratch session listing
 *
 * Reads project-level data (tasks, sessions) from the shared AppStore
 * and calls store actions for mutations (create session, create task session).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { navigateToSession, navigateToProject } from "./router.js";
import type { AppStore } from "./stores/app-store.js";
import type { ActivityState } from "./stores/activity-tracker.js";
import type { TaskList } from "./task-list.js";
import type { TaskForm } from "./task-form.js";
import type { TaskDetail } from "./task-detail.js";
import "./project-sidebar.js";
import "./task-form.js";
import "./task-detail.js";
import "./task-list.js";
import "./session-list.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: AppStore | null = null;

  /** Activity states for all sessions (running/finished indicators). */
  @property({ attribute: false })
  activityMap = new Map<string, ActivityState>();

  @state() private collapsed = window.matchMedia("(max-width: 768px)").matches;

  private _unsubscribe: (() => void) | null = null;

  @query("task-form") private taskForm!: TaskForm;
  @query("task-detail") private taskDetail!: TaskDetail;
  @query("task-list") private taskList!: TaskList;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._subscribe();
    }
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = this.store?.subscribe(() => {
      this.requestUpdate();
      this.taskList?.refreshExpanded();
    }) ?? null;
  }

  // ---- Event handlers from child components --------------------------------

  private handleSelectSession(e: CustomEvent<{ sessionId: string }>) {
    const store = this.store;
    if (!store?.projectId || !e.detail.sessionId) return;
    navigateToSession(store.projectId, e.detail.sessionId);
  }

  private async handleNewSession() {
    const store = this.store;
    if (!store?.projectId) return;
    const sessionId = await store.createSession();
    if (sessionId) {
      navigateToSession(store.projectId, sessionId);
    }
  }

  private async handleNewTaskSession(e: CustomEvent<{ taskId: number }>) {
    const store = this.store;
    if (!store?.projectId) return;
    const result = await store.createTaskSession(e.detail.taskId);
    if ("error" in result) {
      alert(result.error);
      return;
    }
    navigateToSession(store.projectId, result.sessionId);
  }

  private handleEditTask(e: CustomEvent<{ task: import("./ws-client.js").TaskListItem }>) {
    this.taskDetail?.open(e.detail.task);
  }

  private async handleSaveTask(e: CustomEvent<{ taskId: number; title: string; description: string | null }>) {
    const store = this.store;
    if (!store) return;
    const { taskId, title, description } = e.detail;
    const result = await store.updateTask(taskId, { title, description });
    if ("error" in result) {
      this.taskDetail?.saveComplete(result.error);
    } else {
      this.taskDetail?.saveComplete();
    }
  }

  private async handleTaskCreated() {
    await this.store?.refreshLists();
  }

  private async handleDeleteTask(e: CustomEvent<{ taskId: number }>) {
    const store = this.store;
    if (!store) return;

    const result = await store.deleteTask(e.detail.taskId);
    if ("error" in result) {
      alert(result.error);
      return;
    }

    // If the store cleared the active session, navigate to project root
    if (!store.sessionId && store.projectId != null) {
      navigateToProject(store.projectId);
    }
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  /** Render a small badge dot on the collapsed rail if there's activity. */
  private renderRailBadge() {
    let hasRunning = false;
    let hasFinished = false;
    for (const state of this.activityMap.values()) {
      if (state === "running") hasRunning = true;
      else if (state === "finished") hasFinished = true;
    }
    if (!hasRunning && !hasFinished) return nothing;
    const colorClass = hasRunning
      ? "bg-green-500 animate-pulse"
      : "bg-amber-500";
    return html`<span class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${colorClass}"></span>`;
  }

  // ---- Render --------------------------------------------------------------

  override render() {
    const store = this.store;
    const projectId = store?.projectId ?? null;
    const tasks = store?.tasks ?? [];
    const sessions = store?.sessions ?? [];
    const activeSessionId = store?.sessionId ?? "";
    const loading = store?.loading ?? false;

    return html`
      <!-- Collapsed rail -->
      <div class="${this.collapsed ? "" : "hidden"} w-10 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col items-center pt-2 shrink-0">
        <button
          class="relative p-1.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
          @click=${this.toggleCollapse}
          title="Show sidebar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          ${this.renderRailBadge()}
        </button>
      </div>

      <!-- Expanded sidebar -->
      <div
        class="${this.collapsed ? "hidden" : ""} w-64 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col shrink-0"
        @select-session=${this.handleSelectSession}
        @new-session=${this.handleNewSession}
        @new-task-session=${this.handleNewTaskSession}
        @task-created=${this.handleTaskCreated}
        @save-task=${this.handleSaveTask}
        @edit-task=${this.handleEditTask}
        @delete-task=${this.handleDeleteTask}
        @toggle-collapse=${this.toggleCollapse}
      >
        <!-- Project switcher + collapse toggle -->
        <div class="flex items-center border-b border-zinc-700">
          <div class="flex-1 min-w-0">
            <project-sidebar
              .store=${store}
              .activeProjectId=${projectId}
            ></project-sidebar>
          </div>
          <button
            class="p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors shrink-0"
            @click=${this.toggleCollapse}
            title="Hide sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        </div>

        <!-- Task dialogs -->
        <task-form .projectId=${projectId}></task-form>
        <task-detail></task-detail>

        <!-- Assistant (pinned above tasks) -->
        <session-list
          .sessions=${sessions}
          .activeSessionId=${activeSessionId}
          .activityMap=${this.activityMap}
        ></session-list>

        <!-- Scrollable content: tasks -->
        <div class="flex-1 overflow-y-auto">
          ${loading && tasks.length === 0 && sessions.length === 0 ? html`
            <div class="p-3 text-xs text-zinc-500">Loading...</div>
          ` : html`
            <!-- New Task button -->
            <div class="p-2 border-b border-zinc-700">
              <button
                class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
                @click=${() => { this.taskForm?.open(); }}
              >
                + New Task
              </button>
            </div>

            <task-list
              .projectId=${projectId}
              .tasks=${tasks}
              .activeSessionId=${activeSessionId}
              .activityMap=${this.activityMap}
            ></task-list>
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
