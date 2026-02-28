/**
 * Session Sidebar
 *
 * Multi-project orchestrator. Renders ALL projects as collapsible sections,
 * each with its own sessions and tasks. Reads project-level list data from
 * MultiProjectStore (via ProjectDataStore instances) and project metadata
 * from ProjectStore.
 *
 * Child components:
 *  - project-sidebar  — "Add Project" button + project-form modal
 *  - task-form        — new task creation (shared, opened with projectId)
 *  - task-detail      — task editing (shared)
 *  - task-list        — per-project task listing with expandable sessions
 *  - session-list     — per-project scratch session listing
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { navigateToSession } from "./router.js";
import type { AppStore } from "./stores/app-store.js";
import type { ActivityState } from "./stores/app-store.js";
import type { ProjectInfo } from "./ws-client.js";
import type { TaskForm } from "./task-form.js";
import type { TaskDetail } from "./task-detail.js";
import type { ProjectSidebar } from "./project-sidebar.js";
import "./project-sidebar.js";
import "./task-form.js";
import "./task-detail.js";
import "./task-list.js";
import "./session-list.js";
import "./popover-menu.js";

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
  @state() private expandedProjects = new Set<number>();

  private _unsubscribe: (() => void) | null = null;

  @query("task-form") private taskForm!: TaskForm;
  @query("task-detail") private taskDetail!: TaskDetail;
  @query("project-sidebar") private projectSidebar!: ProjectSidebar;

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
    this._autoExpand();
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = this.store?.subscribe(() => {
      this.requestUpdate();
    }) ?? null;
  }

  // ---- Auto-expand logic ----------------------------------------------------

  private _autoExpand() {
    const store = this.store;
    if (!store) return;

    let changed = false;

    // Auto-expand the active project
    if (store.projectId != null && !this.expandedProjects.has(store.projectId)) {
      this.expandedProjects.add(store.projectId);
      store.multiProjectStore.ensureLoaded(store.projectId);
      changed = true;
    }

    // Auto-expand projects with running activity
    const activityByProject = store.activityByProject;
    for (const [projectId, state] of activityByProject) {
      if (state === "running" && !this.expandedProjects.has(projectId)) {
        this.expandedProjects.add(projectId);
        store.multiProjectStore.ensureLoaded(projectId);
        changed = true;
      }
    }

    if (changed) {
      this.expandedProjects = new Set(this.expandedProjects);
    }
  }

  // ---- Toggle ---------------------------------------------------------------

  private toggleProject(projectId: number) {
    const next = new Set(this.expandedProjects);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
      this.store?.multiProjectStore.ensureLoaded(projectId);
    }
    this.expandedProjects = next;
  }

  // ---- Event handlers from child components ---------------------------------

  /** On mobile, collapse the sidebar after navigating. */
  private collapseOnMobile() {
    if (window.innerWidth <= 768) this.collapsed = true;
  }

  private handleSelectSession(e: CustomEvent<{ projectId: number; sessionId: string }>) {
    const { sessionId } = e.detail;
    if (!sessionId) return;
    navigateToSession(sessionId);
    this.collapseOnMobile();
  }

  private async handleNewSession(e: CustomEvent<{ projectId: number }>) {
    const projectId = e.detail.projectId;
    if (!projectId) return;
    try {
      const resp = await fetch(`/api/projects/${projectId}/sessions`, { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        navigateToSession(data.id);
        this.store?.multiProjectStore.refresh(projectId);
        this.collapseOnMobile();
      }
    } catch {
      // silent
    }
  }

  private async handleNewTaskSession(e: CustomEvent<{ projectId: number; taskId: number }>) {
    const { projectId, taskId } = e.detail;
    if (!projectId) return;
    try {
      const resp = await fetch(`/api/tasks/${taskId}/sessions`, { method: "POST" });
      if (resp.ok) {
        const data = await resp.json();
        navigateToSession(data.id);
        this.store?.multiProjectStore.refresh(projectId);
        this.collapseOnMobile();
      } else {
        const err = await resp.json().catch(() => null);
        alert(err?.error ?? "Failed to create session");
      }
    } catch {
      // silent
    }
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

  private async handleDeleteTask(e: CustomEvent<{ projectId: number; taskId: number }>) {
    const store = this.store;
    if (!store) return;

    const { projectId, taskId } = e.detail;
    const result = await store.deleteTask(taskId);
    if ("error" in result) {
      alert(result.error);
      return;
    }

    // Refresh the project data store
    if (projectId) {
      store.multiProjectStore.refresh(projectId);
    }

    // If the store cleared the active session, navigate to empty state
    if (!store.sessionId) {
      location.hash = "";
    }
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  /** Open the sidebar (used by hamburger button on mobile). */
  open() {
    this.collapsed = false;
  }

  private handleEditProject(project: ProjectInfo) {
    this.projectSidebar?.openEdit(project);
  }

  private async handleDeleteProject(project: ProjectInfo) {
    if (!confirm(`Remove "${project.name}" from REINS?\n\nThis won't delete any files on disk.`)) return;

    if (project.id === this.store?.projectId) {
      location.hash = "";
    }
    await this.store?.deleteProject(project.id);
    this.store?.multiProjectStore.remove(project.id);
  }

  // ---- Render helpers -------------------------------------------------------

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

  private renderProjectActivityDot(projectId: number) {
    const state = this.store?.activityByProject.get(projectId);
    if (!state) return nothing;
    const classes = state === "running"
      ? "w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
      : "w-2 h-2 rounded-full bg-amber-500 shrink-0";
    return html`<span class="${classes}"></span>`;
  }

  private get sortedProjects(): ProjectInfo[] {
    return [...(this.store?.projects ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  private renderProjectSection(project: ProjectInfo) {
    const store = this.store!;
    const isExpanded = this.expandedProjects.has(project.id);
    const isActive = project.id === store.projectId;
    const projectData = store.multiProjectStore.peekStore(project.id);

    return html`
      <div class="border-b border-zinc-700">
        <!-- Project header -->
        <div class="flex items-center hover:bg-zinc-700/30 transition-colors group/project ${isActive ? "bg-zinc-800/60" : ""}">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer text-left"
            @click=${() => this.toggleProject(project.id)}
          >
            <span class="text-zinc-500 text-[10px] shrink-0">${isExpanded ? "▼" : "▶"}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                 class="text-zinc-500 shrink-0">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
            </svg>
            <span class="text-xs ${isActive ? "text-zinc-100 font-medium" : "text-zinc-300"} truncate">${project.name}</span>
            ${this.renderProjectActivityDot(project.id)}
          </button>
          <popover-menu
            triggerClass="md:opacity-0 md:group-hover/project:opacity-100"
            .content=${() => html`
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleEditProject(project)}
              >Edit</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleDeleteProject(project)}
              >Remove</button>
            `}
          ></popover-menu>
        </div>

        <!-- Expanded content -->
        ${isExpanded ? html`
          <div class="bg-zinc-900/50">
            ${projectData?.loading && !projectData?.loaded ? html`
              <div class="px-3 py-2 text-[10px] text-zinc-500">Loading...</div>
            ` : html`
              <session-list
                .projectId=${project.id}
                .sessions=${projectData?.sessions ?? []}
                .activeSessionId=${store.sessionId ?? ""}
                .activityMap=${this.activityMap}
              ></session-list>

              <div class="p-2 border-b border-zinc-700">
                <button
                  class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
                  @click=${() => { this.taskForm?.open(project.id); }}
                >
                  + New Task
                </button>
              </div>

              <task-list
                .projectId=${project.id}
                .store=${store}
                .projectDataStore=${projectData ?? null}
                .tasks=${projectData?.tasks ?? []}
                .taskSessions=${projectData?.taskSessions ?? new Map()}
                .activeSessionId=${store.sessionId ?? ""}
                .activityMap=${this.activityMap}
              ></task-list>
            `}
          </div>
        ` : nothing}
      </div>
    `;
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    const store = this.store;

    return html`
      <!-- Mobile backdrop (always rendered, animated) -->
      <div
        class="fixed inset-0 bg-black/50 z-40 md:hidden transition-opacity duration-200 ease-out ${this.collapsed ? "opacity-0 pointer-events-none" : "opacity-100"}"
        @click=${this.toggleCollapse}
      ></div>

      <!-- Sidebar: single div, animated on both mobile (slide) and desktop (width) -->
      <div
        class="${this.collapsed
          ? "max-md:-translate-x-full md:w-10"
          : "max-md:translate-x-0 md:w-64"}
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-64
          max-md:transition-transform md:transition-[width]
          duration-200 ease-out
          h-full bg-zinc-900 border-r border-zinc-700 flex flex-col shrink-0 overflow-hidden"
        @select-session=${this.handleSelectSession}
        @new-session=${this.handleNewSession}
        @new-task-session=${this.handleNewTaskSession}
        @save-task=${this.handleSaveTask}
        @edit-task=${this.handleEditTask}
        @delete-task=${this.handleDeleteTask}
        @toggle-collapse=${this.toggleCollapse}
      >
        <!-- Header: collapse toggle -->
        <div class="flex items-center border-b border-zinc-700 shrink-0 ${this.collapsed ? "justify-center" : ""}">
          ${this.collapsed ? html`
            <!-- Collapsed: centered expand chevron -->
            <button
              class="relative p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${this.toggleCollapse}
              title="Show sidebar"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              ${this.renderRailBadge()}
            </button>
          ` : html`
            <!-- Expanded: collapse chevron -->
            <div class="flex-1 min-w-0"></div>
            <button
              class="p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors shrink-0"
              @click=${this.toggleCollapse}
              title="Hide sidebar"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
          `}
        </div>

        <!-- Sidebar content (hidden when collapsed) -->
        ${!this.collapsed ? html`
          <!-- Shared dialogs -->
          <task-form .store=${store}></task-form>
          <task-detail></task-detail>

          <!-- Scrollable content: project sections -->
          <div class="flex-1 overflow-y-auto">
            ${this.sortedProjects.map(p => this.renderProjectSection(p))}

            <!-- Add Project at the bottom of the list -->
            <project-sidebar .store=${store}></project-sidebar>
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-sidebar": SessionSidebar;
  }
}
