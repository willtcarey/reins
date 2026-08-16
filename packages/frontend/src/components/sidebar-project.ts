import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../controllers/store-controller.js";
import { springCollapse } from "../directives/spring-collapse.js";
import type { ActivityState } from "../models/stores/session-cache.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { ProjectInfo } from "../models/ws-client.js";
import { folderIcon } from "./icons.js";
import {
  createTaskListDisclosureState,
  type TaskListDisclosureState,
} from "./task-list.js";
import "./assistant-session.js";
import "./popover-menu.js";
import "./task-list.js";

@customElement("sidebar-project")
export class SidebarProject extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) project!: ProjectInfo;

  private projectStoreController = new StoreController<ProjectStore>(this);

  @property({ attribute: false })
  set projectStore(store: ProjectStore | null) {
    this.projectStoreController.store = store;
  }

  get projectStore(): ProjectStore | null {
    return this.projectStoreController.store;
  }

  @property({ type: Boolean }) expanded = false;
  @property({ type: Boolean }) active = false;
  @property({ type: String }) activeSessionId = "";
  @property({ attribute: false }) activityState: ActivityState | undefined = undefined;
  @property({ type: Number }) uploadProgress: number | null = null;

  private taskListDisclosureState: TaskListDisclosureState = createTaskListDisclosureState();

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

  private dispatchProjectEvent(name: string) {
    this.dispatchEvent(new CustomEvent(name, {
      detail: this.project,
      bubbles: true,
      composed: true,
    }));
  }

  private renderActivityDot() {
    if (!this.activityState) return nothing;
    const classes = this.activityState === "running"
      ? "w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
      : "w-2 h-2 rounded-full bg-amber-500 shrink-0";
    return html`<span class=${classes}></span>`;
  }

  override render() {
    const project = this.project;
    if (!project) return nothing;

    return html`
      <div class="px-1.5 py-0.5">
        <div class="flex items-center rounded-md overflow-hidden transition-colors group/project relative z-10 ${this.active ? "bg-zinc-800/70" : "hover:bg-zinc-800/70"} ${this.expanded ? "shadow-[0_4px_6px_-2px_rgba(0,0,0,0.5)]" : ""}">
          <button
            class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 cursor-pointer text-left"
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
                @click=${() => this.dispatchProjectEvent("edit-project")}
              >Edit</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.dispatchProjectEvent("upload-project-files")}
              >Upload files</button>
              <button
                class="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-700 cursor-pointer transition-colors"
                @click=${() => this.dispatchProjectEvent("delete-project")}
              >Remove</button>
            `}
          ></popover-menu>
        </div>

        ${this.uploadProgress !== null ? html`
          <div class="px-3 py-1.5 bg-zinc-800/80 border-b border-zinc-700/50">
            <div class="flex items-center gap-2 text-xs text-zinc-300">
              <span>Uploading… ${this.uploadProgress}%</span>
            </div>
            <div class="mt-1 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
              <div
                class="h-full rounded-full bg-blue-500 transition-[width] duration-200 ease-out"
                style="width: ${this.uploadProgress}%"
              ></div>
            </div>
          </div>
        ` : nothing}

        ${springCollapse(!this.expanded, () => html`
          <div class="mt-1 rounded-lg bg-black/25 border border-zinc-800/80 overflow-hidden shadow-[inset_0_6px_8px_-4px_rgba(0,0,0,0.6),inset_0_-6px_8px_-4px_rgba(0,0,0,0.6)]">
            ${this.projectStore?.loading && !this.projectStore.loaded ? html`
              <div class="px-3 py-2 text-[10px] text-zinc-500">Loading...</div>
            ` : html`
              <assistant-session
                .projectId=${project.id}
                .sessions=${this.projectStore?.sessions ?? []}
                .activeSessionId=${this.activeSessionId}
              ></assistant-session>

              <task-list
                .projectId=${project.id}
                .projectStore=${this.projectStore}
                .activeSessionId=${this.activeSessionId}
                .disclosureState=${this.taskListDisclosureState}
              ></task-list>
            `}
          </div>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sidebar-project": SidebarProject;
  }
}
