/**
 * The sidebar's Projects section: every project, by name, each expanding to its assistant's
 * conversations and its tasks (`project-tree.ts` says which are expanded); then the sessions of no project, and
 * Add project. It never scrolls the sidebar: opening a session, from here or another section, leaves the sidebar
 * where the user had it (the session opened is first in Recent anyway).
 * Its dialogs (new task, task details, project form) are its own for now. It uses only the SDK.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { Disposer, Project, ReinsSdk, Task } from "@reins/sdk";
import { confirmDialog } from "../../../ui/confirm-dialog.js";
import { showToast } from "../../../ui/toast.js";
import type { RenameSessionDetail, SaveTaskDetail } from "../../../components/events.js";
import { SubscriptionsController } from "../../../controllers/subscriptions-controller.js";
import { ProjectExpansion } from "./project-tree.js";
import type { ProjectForm } from "./project-form.js";
import type { TaskDetail } from "./task-detail.js";
import type { TaskForm } from "./task-form.js";
import "./project-form.js";
import "./sidebar-project.js";
import "./task-detail.js";
import "./task-form.js";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What the section draws of the main area: the project shown and the session shown. */
const shownKey = (sdk: ReinsSdk) => JSON.stringify([sdk.workspace.currentSubject("project"), sdk.workspace.currentSubject("session")]);

@customElement("sidebar-projects")
export class ProjectsSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) reins: ReinsSdk | null = null;

  @query("task-form") private taskForm!: TaskForm;
  @query("task-detail") private taskDetail!: TaskDetail;
  @query("project-form") private projectForm!: ProjectForm;

  private expansion = new ProjectExpansion();
  private editedTask: Task | null = null;

  constructor() {
    super();
    // The project rows, the sessions of no project (Other sessions) and what the main area shows; each project's
    // conversations and tasks are its row's.
    new SubscriptionsController(this, () => this.reins, (reins) => [
      reins.projects.onDidChange(() => this.requestUpdate()),
      reins.sessions.onDidChange(({ projectIds }) => { if (projectIds.includes(null)) this.requestUpdate(); }),
      // Only the shown project and session are drawn: a review scrolled to another file must not draw every project again.
      reins.workspace.onDidChange(() => { if (shownKey(reins) !== this.drawnShown) this.requestUpdate(); }),
    ]);
  }

  private drawnShown: string | null = null;

  override willUpdate() {
    this.drawnShown = this.reins ? shownKey(this.reins) : null;
    this.expansion.follow(this.reins?.workspace.currentSubject("project") ?? null);
  }

  /** Any of its rows, a project's or Other sessions'. */
  private handleRenameSession(event: CustomEvent<RenameSessionDetail>) {
    event.stopPropagation();
    this.reins?.ui.renameSession(event.detail.sessionId).catch((error: unknown) => showToast(errorMessage(error), "error"));
  }

  private openMain(view: Parameters<ReinsSdk["workspace"]["open"]>[0]) {
    this.reins?.workspace.open(view, { in: "main" });
  }

  private handleSelectSession(event: CustomEvent<{ sessionId: string }>) {
    if (event.detail.sessionId) this.openMain({ view: "session", sessionId: event.detail.sessionId });
  }

  private handleNewSession(event: CustomEvent<{ projectId: number }>) {
    if (event.detail.projectId) this.openMain({ view: "new-session", projectId: event.detail.projectId, taskId: null });
  }

  private handleNewTaskSession(event: CustomEvent<{ projectId: number; taskId: number }>) {
    const { projectId, taskId } = event.detail;
    if (projectId) this.openMain({ view: "new-session", projectId, taskId });
  }

  private handleToggleProject(event: CustomEvent<Project>) {
    this.expansion.toggle(event.detail.id);
    this.requestUpdate();
  }

  private handleEditTask(event: CustomEvent<{ task: Task }>) {
    this.editedTask = event.detail.task;
    this.taskDetail?.open(event.detail.task);
  }

  private async handleSaveTask(event: CustomEvent<SaveTaskDetail>) {
    const task = this.editedTask;
    if (!task || !this.reins) return;
    const { taskId, title, description } = event.detail;
    try {
      await this.reins.tasks.update(task.projectId, taskId, { title, description });
      this.taskDetail?.saveComplete();
    } catch (error) {
      this.taskDetail?.saveComplete(errorMessage(error));
    }
  }

  /** Deleting the task of the session shown leaves the main area on the project's new session page. */
  private async handleDeleteTask(event: CustomEvent<{ projectId: number | null; taskId: number }>) {
    const reins = this.reins;
    const { projectId, taskId } = event.detail;
    if (!reins || projectId == null) return;
    const shown = reins.workspace.currentSubject("task") === taskId;
    try {
      await reins.tasks.remove(projectId, taskId);
    } catch (error) {
      showToast(errorMessage(error), "error");
      return;
    }
    if (shown) this.openMain({ view: "new-session", projectId, taskId: null });
  }

  private async handleDeleteProject(event: CustomEvent<Project>) {
    const reins = this.reins;
    const project = event.detail;
    if (!reins) return;
    const confirmed = await confirmDialog({
      title: `Remove ${project.name} from REINS?`,
      message: "This won't delete any files on disk.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    const shown = reins.workspace.currentSubject("project") === project.id;
    try {
      await reins.projects.remove(project.id);
    } catch (error) {
      showToast(`Failed to remove ${project.name}: ${errorMessage(error)}`, "error");
      return;
    }
    if (shown) this.openMain({ view: "new-session", projectId: null, taskId: null });
  }

  /** Sessions of no project (Reins features such as extensions create them; the browser does not), so a
   * visible one stays reachable. Listed only when there is one; opening one is all they offer here. */
  private renderOtherSessions(reins: ReinsSdk, activeSessionId: string) {
    const sessions = reins.sessions.list({ projectId: null });
    if (sessions.length === 0) return nothing;
    return html`
      <section class="mt-2" aria-label="Other sessions">
        <div class="px-3 py-1.5 text-[11px] font-medium text-zinc-400">Other sessions</div>
        <div class="mx-2 mb-1 divide-y divide-zinc-800/80 rounded-md border border-zinc-800/80 bg-zinc-950/30 overflow-hidden">
          ${sessions.map((session) => html`
            <session-list-item
              class="block"
              .session=${session}
              .active=${session.id === activeSessionId}
              .activeSessionId=${activeSessionId}
              .movable=${false}
            ></session-list-item>
          `)}
        </div>
      </section>
    `;
  }

  override render() {
    const reins = this.reins;
    if (!reins) return nothing;
    const currentProject = reins.workspace.currentSubject("project");
    const activeSessionId = reins.workspace.currentSubject("session") ?? "";

    return html`
      <div
        @select-session=${this.handleSelectSession}
        @rename-session=${this.handleRenameSession}
        @new-session=${this.handleNewSession}
        @new-task=${(event: CustomEvent<{ projectId: number }>) => this.taskForm?.open(event.detail.projectId)}
        @new-task-session=${this.handleNewTaskSession}
        @toggle-project=${this.handleToggleProject}
        @edit-project=${(event: CustomEvent<Project>) => this.projectForm?.open({ mode: "edit", project: event.detail })}
        @delete-project=${this.handleDeleteProject}
        @edit-task=${this.handleEditTask}
        @save-task=${this.handleSaveTask}
        @delete-task=${this.handleDeleteTask}
      >
        ${repeat(reins.projects.list(), (project) => project.id, (project) => html`
          <sidebar-project
            .project=${project}
            .reins=${reins}
            .expanded=${this.expansion.isExpanded(project.id)}
            .active=${project.id === currentProject}
            .activeSessionId=${activeSessionId}
          ></sidebar-project>
        `)}

        ${this.renderOtherSessions(reins, activeSessionId)}

        <div class="p-2">
          <button
            class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
            @click=${() => this.projectForm?.open({ mode: "create" })}
          >+ Add Project</button>
        </div>
      </div>

      <task-form .tasks=${reins.tasks}></task-form>
      <task-detail></task-detail>
      <project-form .reins=${reins}></project-form>
    `;
  }
}

export function registerProjects(reins: ReinsSdk): Disposer {
  return reins.sidebar.registerSection({
    id: "projects",
    title: "Projects",
    mount: (target) => {
      const section = target.ownerDocument.createElement("sidebar-projects");
      section.reins = reins;
      target.append(section);
      return { dispose: () => section.remove() };
    },
  });
}

declare global {
  interface HTMLElementTagNameMap {
    "sidebar-projects": ProjectsSection;
  }
}
