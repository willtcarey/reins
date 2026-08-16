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
 *  - sidebar-project  — keyed project section with persistent disclosure state
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { navigateToSession } from "../models/router.js";
import type { AppStore } from "../models/stores/app-store.js";
import type { TaskListItem } from "../models/tasks.js";

import type { ProjectInfo } from "../models/ws-client.js";
import { chevronLeftIcon, chevronRightIcon } from "./icons.js";
import type { TaskForm } from "./task-form.js";
import type { TaskDetail } from "./task-detail.js";
import type { ProjectSidebar } from "./project-sidebar.js";
import "./project-sidebar.js";
import "./task-form.js";
import "./task-detail.js";
import "./sidebar-project.js";
import { showToast } from "./toast.js";
import { openQuickOpenEvent, openSettingsEvent } from "./events.js";
import { ScrollToController } from "../controllers/scroll-to-controller.js";
import { ViewportController } from "../controllers/viewport-controller.js";
import "./nav-icon.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: AppStore | null = null;

  @state() private collapsed = false;
  @state() private expandedProjects = new Set<number>();

  /** Upload progress per project: 0–100 while uploading, null when idle. */
  @state() private uploadProgress = new Map<number, number>();

  private _unsubscribe: (() => void) | null = null;
  private viewport = new ViewportController(this);
  private _activeSessionScroll = new ScrollToController(this, {
    getTargetId: () => this.store?.sessionId,
    targetSelector: "[data-session-id]",
    getItemId: (row) => row.getAttribute("data-session-id") ?? undefined,
    scrollContainerSelector: "[data-sidebar-scroll-container]",
  });

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

  private handleSelectSession(e: CustomEvent<{ projectId: number; sessionId: string }>) {
    const { sessionId } = e.detail;
    if (!sessionId) return;
    navigateToSession(sessionId);
  }

  private async handleNewSession(e: CustomEvent<{ projectId: number }>) {
    const projectId = e.detail.projectId;
    if (!projectId) return;
    const result = await this.store?.createSession(projectId);
    if (result && "sessionId" in result) {
      navigateToSession(result.sessionId);
    }
  }

  private handleNewTask(e: CustomEvent<{ projectId: number }>) {
    this.taskForm?.open(e.detail.projectId);
  }

  private async handleNewTaskSession(e: CustomEvent<{ projectId: number; taskId: number }>) {
    const { projectId, taskId } = e.detail;
    if (!projectId) return;
    const result = await this.store?.createTaskSession(taskId, projectId);
    if (result && "sessionId" in result) {
      navigateToSession(result.sessionId);
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
    if (this.viewport.isMobileLayout) return;
    this.collapsed = !this.collapsed;
  }

  /** Open the quick-open palette (Cmd+K). */
  private _openQuickOpen() {
    this.dispatchEvent(openQuickOpenEvent());
  }

  /** Open the settings panel. */
  private _openSettings() {
    this.dispatchEvent(openSettingsEvent());
  }

  private handleToggleProject(e: CustomEvent<ProjectInfo>) {
    this.toggleProject(e.detail.id);
  }

  private handleEditProject(e: CustomEvent<ProjectInfo>) {
    this.projectSidebar?.openEdit(e.detail);
  }

  private handleUploadFiles(e: CustomEvent<ProjectInfo>) {
    const project = e.detail;
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
        store.diffStore.refresh({ trigger: "upload" });
      } else {
        showToast(result.error, "error");
      }
    });
    input.click();
  }

  private async handleDeleteProject(e: CustomEvent<ProjectInfo>) {
    const project = e.detail;
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

  private get sortedProjects(): ProjectInfo[] {
    return (this.store?.projects ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  // ---- Render ---------------------------------------------------------------

  override render() {
    const store = this.store;
    const isCollapsed = !this.viewport.isMobileLayout && this.collapsed;
    const shellClass = `${isCollapsed ? "md:w-10" : "w-full md:w-64"}
      h-full bg-zinc-900 border-r border-zinc-700 flex flex-col shrink-0 overflow-hidden
      md:transition-[width] duration-200 ease-out`;

    return html`
      <div
        class=${shellClass}
        @select-session=${this.handleSelectSession}
        @new-session=${this.handleNewSession}
        @new-task=${this.handleNewTask}
        @new-task-session=${this.handleNewTaskSession}
        @toggle-project=${this.handleToggleProject}
        @edit-project=${this.handleEditProject}
        @upload-project-files=${this.handleUploadFiles}
        @delete-project=${this.handleDeleteProject}
        @save-task=${this.handleSaveTask}
        @edit-task=${this.handleEditTask}
        @delete-task=${this.handleDeleteTask}
        @toggle-collapse=${this.toggleCollapse}
      >
        <!-- Header: collapse toggle + quick-open -->
        <div class="flex items-center border-b border-zinc-800/80 shrink-0 ${isCollapsed ? "justify-center" : "h-[50px] px-2 gap-1"}">
          ${isCollapsed ? html`
            <!-- Collapsed: expand chevron + search icon -->
            <div class="flex flex-col items-center gap-1 py-1">
              <button
                class="relative p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${this.toggleCollapse}
                title="Show sidebar"
              >
                ${chevronRightIcon()}
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
              class="hidden md:block p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer transition-colors shrink-0"
              @click=${this.toggleCollapse}
              title="Hide sidebar"
            >
              ${chevronLeftIcon()}
            </button>
          `}
        </div>

        <!-- Sidebar content (hidden when collapsed) -->
        ${!isCollapsed ? html`
          <!-- Shared dialogs -->
          <task-form .store=${store}></task-form>
          <task-detail></task-detail>

          <!-- Scrollable content: project sections -->
          <div
            class="flex-1 overflow-y-auto"
            data-sidebar-scroll-container
            data-swipe-surface
          >
            ${repeat(
              this.sortedProjects,
              (project) => project.id,
              (project) => html`
                <sidebar-project
                  .project=${project}
                  .projectStore=${store?.projectsStore.peekStore(project.id) ?? null}
                  .expanded=${this.expandedProjects.has(project.id)}
                  .active=${project.id === store?.projectId}
                  .activeSessionId=${store?.sessionId ?? ""}
                  .activityState=${store?.projectsStore.activityForProject(project.id)}
                  .uploadProgress=${this.uploadProgress.get(project.id) ?? null}
                ></sidebar-project>
              `,
            )}

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
