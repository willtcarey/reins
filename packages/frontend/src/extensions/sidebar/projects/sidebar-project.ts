import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { Project, ReinsSdk, SessionSummary } from "@reins/sdk";
import { springCollapse } from "../../../directives/spring-collapse.js";
import {
  newSessionEvent,
  projectEvent,
  type ProjectEventName,
  type MoveSessionDetail,
} from "../../../components/events.js";
import { conversationIcon, folderIcon, plusIcon } from "../../../ui/icons.js";
import { statusDot } from "../../../ui/status-dot.js";
import type { LocationDialog } from "../../../components/location-dialog.js";
import {
  createTaskListDisclosureState,
  type TaskListDisclosureState,
} from "./task-list.js";
import { SubscriptionsController } from "../../../controllers/subscriptions-controller.js";
import "../../../ui/popover-menu.js";
import "./session-list-item.js";
import "../../../components/location-dialog.js";
import "./task-list.js";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A project in the Projects section: its row (activity, menu) and, while expanded, its assistant's
 * conversations and its tasks, read from the SDK. */
@customElement("sidebar-project")
export class SidebarProject extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) project!: Project;
  @property({ attribute: false }) reins: ReinsSdk | null = null;
  @property({ type: Boolean }) expanded = false;
  @property({ type: Boolean }) active = false;
  @property({ type: String }) activeSessionId = "";

  @query("location-dialog") private moveDialog!: LocationDialog;

  private taskListDisclosureState: TaskListDisclosureState = createTaskListDisclosureState();

  constructor() {
    super();
    // Its conversations and whether its tasks loaded; the project itself comes from the section.
    const mine = ({ projectIds }: { projectIds: readonly (number | null)[] }) => {
      if (projectIds.includes(this.project.id)) this.requestUpdate();
    };
    new SubscriptionsController(this, () => this.reins, (reins) => [reins.sessions.onDidChange(mine), reins.tasks.onDidChange(mine)]);
  }

  override willUpdate(changed: Map<string, unknown>) {
    const previousProject = changed.get("project");
    if (
      typeof previousProject === "object"
      && previousProject !== null
      && "id" in previousProject
      && previousProject.id !== this.project.id
    ) {
      this.taskListDisclosureState = createTaskListDisclosureState();
    }
  }

  /** Any loaded session of the project: its conversations, its tasks' and their delegates'. */
  private findSession(sessionId: string): SessionSummary | undefined {
    return this.reins?.sessions.list({ projectId: this.project.id }).find((session) => session.id === sessionId);
  }

  private dispatchProjectEvent(name: ProjectEventName) {
    this.dispatchEvent(projectEvent(name, this.project));
  }

  private handleNewSession() {
    this.dispatchEvent(newSessionEvent(this.project.id));
  }

  private handleMoveSession(event: CustomEvent<MoveSessionDetail>) {
    event.stopPropagation();
    const reins = this.reins;
    const session = this.findSession(event.detail.sessionId);
    if (!reins || !session) return;
    void this.moveDialog?.open({
      heading: "Move Session",
      subtitle: session.name || session.firstMessage || "Empty session",
      confirmLabel: "Move",
      busyLabel: "Moving…",
      loadTargets: () => reins.sessions.moveTargets(session.id).then(
        (targets) => targets.map((target) => ({ ...target, paths: [...target.paths] })),
        (error: unknown) => ({ error: errorMessage(error) }),
      ),
      choose: (nodeId, path) => reins.sessions.move(session.id, { nodeId, path }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ error: errorMessage(error) }),
      ),
    });
  }

  private renderScratchSessions(reins: ReinsSdk) {
    const sessions = reins.sessions.list({ projectId: this.project.id, taskId: null });

    return html`
      <div class="flex items-center px-3 pt-3 pb-1">
        <h2 class="flex-1 text-[9px] font-semibold text-zinc-600 uppercase tracking-wider">
          ${sessions.length > 0 ? "Assistant" : "Start a conversation"}
        </h2>
        <button
          class="p-0.5 text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors shrink-0"
          @click=${this.handleNewSession}
          title="New conversation"
        >${sessions.length > 0 ? plusIcon("", 10) : conversationIcon("", 12)}</button>
      </div>
      ${sessions.length > 0 ? html`
        <div class="mx-2 mb-1 divide-y divide-zinc-800/80 rounded-md border border-zinc-800/80 bg-zinc-950/30 overflow-hidden">
          ${sessions.map((session) => html`
            <session-list-item
              class="block"
              .session=${session}
              .active=${session.id === this.activeSessionId}
              .activeSessionId=${this.activeSessionId}
              .sessions=${reins.sessions}
            ></session-list-item>
          `)}
        </div>
      ` : html`
        <button
          class="mx-2 mb-2 flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-400 hover:text-zinc-300 cursor-pointer"
          @click=${this.handleNewSession}
        >
          ${conversationIcon("shrink-0")}
          <span>Start a conversation</span>
        </button>
      `}
    `;
  }

  private renderActivityDot() {
    const { activity } = this.project;
    if (!activity) return nothing;
    return activity === "running"
      ? statusDot("success", { label: "Running", pulse: true })
      : statusDot("warning", { label: "New activity" });
  }

  private renderBody(reins: ReinsSdk | null) {
    if (!reins) return nothing;
    // Asking for its tasks loads the project the first time it expands.
    reins.tasks.list(this.project.id);
    if (!reins.tasks.loaded(this.project.id)) return html`<div class="px-3 py-2 text-[10px] text-zinc-500">Loading...</div>`;
    return html`
      ${this.renderScratchSessions(reins)}
      <task-list
        .projectId=${this.project.id}
        .reins=${reins}
        .activeSessionId=${this.activeSessionId}
        .disclosureState=${this.taskListDisclosureState}
      ></task-list>
    `;
  }

  override render() {
    const project = this.project;
    if (!project) return nothing;

    return html`
      <div
        class="px-1.5 py-0.5"
        @move-session=${this.handleMoveSession}
      >
        <div class="flex items-center rounded-md overflow-hidden transition-colors group/project relative z-10 ${this.active ? "bg-zinc-800/70" : "hover:bg-zinc-800/70"} ${this.expanded ? "shadow-[0_4px_6px_-2px_rgba(0,0,0,0.5)]" : ""}">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer text-left"
            aria-expanded=${this.expanded ? "true" : "false"}
            @click=${() => this.dispatchProjectEvent("toggle-project")}
          >
            <span class="text-zinc-500 text-[10px] shrink-0">${this.expanded ? "▼" : "▶"}</span>
            ${folderIcon("text-zinc-500 shrink-0", 14)}
            <span class="text-sm font-medium ${this.active ? "text-zinc-100" : "text-zinc-300"} truncate">${project.name}</span>
            ${this.renderActivityDot()}
          </button>
          <popover-menu
            triggerClass="md:opacity-0 md:group-hover/project:opacity-100"
            close-on-panel-click
            .content=${() => html`
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.reins?.workspace.open({ view: "project-history", projectId: project.id }, { in: "main" })}
              >History</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.dispatchProjectEvent("edit-project")}
              >Edit</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.dispatchProjectEvent("delete-project")}
              >Remove</button>
            `}
          ></popover-menu>
        </div>

        ${springCollapse(!this.expanded, () => html`
          <div class="mt-1 rounded-lg bg-black/25 border border-zinc-800/80 overflow-hidden shadow-[inset_0_6px_8px_-4px_rgba(0,0,0,0.6),inset_0_-6px_8px_-4px_rgba(0,0,0,0.6)]">
            ${this.renderBody(this.reins)}
          </div>
        `)}

        <location-dialog></location-dialog>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sidebar-project": SidebarProject;
  }
}
