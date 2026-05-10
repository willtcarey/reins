/**
 * Session Sidebar
 *
 * Multi-project orchestrator. Renders ALL projects as collapsible sections,
 * each with its own sessions and tasks. Reads project list and per-project
 * data from AppStore's public ProjectsStore sub-store.
 *
 * Child components:
 *  - project-sidebar  — "Add Project" button + project-form modal
 *  - task-form        — new task creation (shared, opened with projectId)
 *  - task-detail      — task editing (shared)
 *  - task-list        — per-project task listing with expandable sessions
 *  - assistant-session — per-project scratch session row + history popover
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { navigateToSession } from "../models/router.js";
import type { AppStore } from "../models/stores/app-store.js";
import { TasksCollection, type TaskListItem } from "../models/tasks.js";
import type { ActivityState } from "../models/stores/activity-store.js";

import type { ProjectInfo } from "../models/ws-client.js";
import type { TaskForm } from "./task-form.js";
import type { TaskDetail } from "./task-detail.js";
import type { ProjectSidebar } from "./project-sidebar.js";
import "./project-sidebar.js";
import "./task-form.js";
import "./task-detail.js";
import "./task-list.js";
import "./assistant-session.js";
import "./popover-menu.js";
import { showToast } from "./toast.js";
import { openQuickOpenEvent, openSettingsEvent } from "./events.js";
import "./nav-icon.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: AppStore | null = null;

  @state() private collapsed = window.matchMedia("(max-width: 768px)").matches;
  @state() private expandedProjects = new Set<number>();

  /** Upload progress per project: 0–100 while uploading, null when idle. */
  @state() private uploadProgress = new Map<number, number>();

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

    // Auto-expand the project containing the visited session
    if (store.projectId != null && !this.expandedProjects.has(store.projectId)) {
      this.expandedProjects.add(store.projectId);
      store.projectsStore.ensureLoaded(store.projectId);
      changed = true;
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
      this.store?.projectsStore.ensureLoaded(projectId);
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
    const result = await this.store?.createSession(projectId);
    if (result && "sessionId" in result) {
      navigateToSession(result.sessionId);
      this.collapseOnMobile();
    }
  }

  private async handleNewTaskSession(e: CustomEvent<{ projectId: number; taskId: number }>) {
    const { projectId, taskId } = e.detail;
    if (!projectId) return;
    const result = await this.store?.createTaskSession(taskId, projectId);
    if (result && "sessionId" in result) {
      navigateToSession(result.sessionId);
      this.collapseOnMobile();
    } else if (result && "error" in result) {
      showToast(result.error, "error");
    }
  }

  private handleEditTask(e: CustomEvent<{ task: TaskListItem }>) {
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
      showToast(result.error, "error");
      return;
    }

    // Refresh the project data store
    if (projectId) {
      store.projectsStore.refresh(projectId);
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

  /** Open the quick-open palette (Cmd+K). */
  private _openQuickOpen() {
    this.dispatchEvent(openQuickOpenEvent());
  }

  /** Open the settings panel. */
  private _openSettings() {
    this.dispatchEvent(openSettingsEvent());
  }

  private handleEditProject(project: ProjectInfo) {
    this.projectSidebar?.openEdit(project);
  }

  private handleUploadFiles(project: ProjectInfo) {
    const store = this.store;
    if (!store) return;

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", async () => {
      const files = input.files;
      if (!files || files.length === 0) return;

      const onProgress = (pct: number) => {
        this.uploadProgress = new Map(this.uploadProgress).set(project.id, pct);
      };

      const result = await store.projectsStore.uploadFiles(
        project.id,
        files,
        onProgress,
      );

      // Show 100% briefly, then clear
      this.uploadProgress = new Map(this.uploadProgress).set(project.id, 100);
      setTimeout(() => {
        const next = new Map(this.uploadProgress);
        next.delete(project.id);
        this.uploadProgress = next;
      }, 600);

      if ("uploaded" in result) {
        const count = result.uploaded.length;
        showToast(
          `Uploaded ${count} file${count !== 1 ? "s" : ""} successfully.`,
          "success",
        );
        // Refresh the diff view so uploaded files appear in the changes tab
        store.diffStore.refresh();
      } else {
        showToast(result.error, "error");
      }
    });
    input.click();
  }

  private async handleDeleteProject(project: ProjectInfo) {
    if (!confirm(`Remove "${project.name}" from REINS?\n\nThis won't delete any files on disk.`)) return;

    if (project.id === this.store?.projectId) {
      location.hash = "";
    }
    await this.store?.deleteProject(project.id);
    this.store?.projectsStore.remove(project.id);
  }

  // ---- Render helpers -------------------------------------------------------

  /** Render a small badge dot on the collapsed rail if there's activity. */
  private renderRailBadge() {
    const summary = this.store?.projectsStore.activitySummary;
    const hasRunning = (summary?.running ?? 0) > 0;
    const hasFinished = (summary?.finished ?? 0) > 0;
    if (!hasRunning && !hasFinished) return nothing;
    const colorClass = hasRunning
      ? "bg-green-500 animate-pulse"
      : "bg-amber-500";
    return html`<span class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${colorClass}"></span>`;
  }

  private renderProjectActivityDot(projectId: number) {
    const activity = this.store?.projectsStore.activityForProject(projectId);
    if (!activity) return nothing;
    const classes = activity === "running"
      ? "w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
      : "w-2 h-2 rounded-full bg-amber-500 shrink-0";
    return html`<span class="${classes}"></span>`;
  }

  private get sortedProjects(): ProjectInfo[] {
    return (this.store?.projects ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  private renderProjectSection(project: ProjectInfo) {
    const store = this.store!;
    const isExpanded = this.expandedProjects.has(project.id);
    const isActive = project.id === store.projectId;
    const projectData = store.projectsStore.peekStore(project.id);
    const projectActivityMap = projectData?.activityMap ?? new Map<string, ActivityState>();

    return html`
      <div class="px-1.5 py-0.5">
        <!-- Project header -->
        <div class="flex items-center rounded-md overflow-hidden transition-colors group/project relative z-10 ${isActive ? "bg-zinc-800/70" : "hover:bg-zinc-800/70"} ${isExpanded ? "shadow-[0_4px_6px_-2px_rgba(0,0,0,0.5)]" : ""}">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer text-left"
            @click=${() => this.toggleProject(project.id)}
          >
            <span class="text-zinc-500 text-[10px] shrink-0">${isExpanded ? "▼" : "▶"}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                 class="text-zinc-500 shrink-0">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
            </svg>
            <span class="text-sm font-medium ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${project.name}</span>
            ${this.renderProjectActivityDot(project.id)}
          </button>
          <popover-menu
            triggerClass="md:opacity-0 md:group-hover/project:opacity-100"
            close-on-panel-click
            .content=${() => html`
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleEditProject(project)}
              >Edit</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleUploadFiles(project)}
              >Upload files</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.handleDeleteProject(project)}
              >Remove</button>
            `}
          ></popover-menu>
        </div>

        <!-- Upload progress bar -->
        ${this.uploadProgress.has(project.id) ? html`
          <div class="px-3 py-1.5 bg-zinc-800/80 border-b border-zinc-700/50">
            <div class="flex items-center gap-2 text-xs text-zinc-300">
              <span>Uploading… ${this.uploadProgress.get(project.id)}%</span>
            </div>
            <div class="mt-1 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
              <div
                class="h-full rounded-full bg-blue-500 transition-[width] duration-200 ease-out"
                style="width: ${this.uploadProgress.get(project.id)}%"
              ></div>
            </div>
          </div>
        ` : nothing}

        <!-- Expanded content (animated accordion) -->
        <div class="grid transition-[grid-template-rows] duration-200 ease-out ${isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}">
          <div class="overflow-hidden">
            <div class="mt-1 rounded-lg bg-black/25 border border-zinc-800/80 overflow-hidden shadow-[inset_0_6px_8px_-4px_rgba(0,0,0,0.6),inset_0_-6px_8px_-4px_rgba(0,0,0,0.6)]">
              ${projectData?.loading && !projectData?.loaded ? html`
                <div class="px-3 py-2 text-[10px] text-zinc-500">Loading...</div>
              ` : html`
                <assistant-session
                  .projectId=${project.id}
                  .sessions=${projectData?.sessions ?? []}
                  .activeSessionId=${store.sessionId ?? ""}
                  .activityMap=${projectActivityMap}
                ></assistant-session>

                <task-list
                  @new-task=${() => { this.taskForm?.open(project.id); }}
                  .projectId=${project.id}
                  .projectStore=${projectData ?? null}
                  .tasksCollection=${projectData?.tasksWithActivity ?? TasksCollection.empty(project.id)}
                  .taskSessions=${projectData?.taskSessions ?? new Map()}
                  .activeSessionId=${store.sessionId ?? ""}
                  .activityMap=${projectActivityMap}
                ></task-list>
              `}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    const store = this.store;

    return html`
      <!-- Mobile backdrop (always rendered, animated) -->
      <div
        class="fixed inset-0 bg-black/50 z-[var(--layer-sidebar)] md:hidden transition-opacity duration-200 ease-out ${this.collapsed ? "opacity-0 pointer-events-none" : "opacity-100"}"
        @click=${this.toggleCollapse}
      ></div>

      <!-- Sidebar: single div, animated on both mobile (slide) and desktop (width) -->
      <div
        class="${this.collapsed
          ? "max-md:-translate-x-full md:w-10"
          : "max-md:translate-x-0 md:w-64"}
          max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[var(--layer-overlay)] max-md:w-64
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
        <!-- Header: collapse toggle + quick-open -->
        <div class="flex items-center border-b border-zinc-800/80 shrink-0 ${this.collapsed ? "justify-center" : "h-[50px] px-2 gap-1"}">
          ${this.collapsed ? html`
            <!-- Collapsed: expand chevron + search icon -->
            <div class="flex flex-col items-center gap-1 py-1">
              <button
                class="relative p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${this.toggleCollapse}
                title="Show sidebar"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                ${this.renderRailBadge()}
              </button>
              <nav-icon icon="search" label="Search sessions (Cmd+K)" compact @click=${this._openQuickOpen}></nav-icon>
              <nav-icon icon="settings" label="Settings" compact @click=${this._openSettings}></nav-icon>
            </div>
          ` : html`
            <!-- Expanded: search button + settings gear + collapse chevron -->
            <nav-icon icon="search" label="Search sessions (Cmd+K)" .size=${18} @click=${this._openQuickOpen}></nav-icon>
            <nav-icon icon="settings" label="Settings" .size=${18} @click=${this._openSettings}></nav-icon>
            <div class="flex-1 min-w-0"></div>
            <button
              class="p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer transition-colors shrink-0"
              @click=${this.toggleCollapse}
              title="Hide sidebar"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
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
