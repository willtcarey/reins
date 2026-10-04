/**
 * Project Form Dialog
 *
 * Modal dialog for creating or editing a project.
 * Supports both modes via open({ mode, project? }).
 * Project mutations go through the route-scoped workspace interface, which
 * delegates project-domain work to ProjectsStore.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { Project as ProjectInfo } from "@backend/project-store.js";
import type { NodeView } from "@backend/routes/nodes.js";
import type { WorkspaceStore } from "../models/stores/workspace-store.js";
import { projectCreatedEvent, projectUpdatedEvent } from "./events.js";

interface OpenCreateOptions {
  mode: "create";
}

interface OpenEditOptions {
  mode: "edit";
  project: ProjectInfo;
}

@customElement("project-form")
export class ProjectForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: WorkspaceStore | null = null;

  @state() private mode: "create" | "edit" = "create";
  @state() private editProjectId: number | null = null;
  @state() private name = "";
  @state() private path = "";
  /** Where a new project's checkout is (create only: its first source). */
  @state() private nodes: NodeView[] | null = null;
  @state() private nodeId = "";
  @state() private baseBranch = "main";
  @state() private error = "";
  @state() private submitting = false;

  @query("dialog") private dialog!: HTMLDialogElement;

  /** Open the dialog for creating or editing a project. */
  open(options: OpenCreateOptions | OpenEditOptions) {
    this.mode = options.mode;
    this.error = "";
    this.submitting = false;

    if (options.mode === "edit") {
      this.editProjectId = options.project.id;
      this.name = options.project.name;
      this.path = options.project.path;
      this.baseBranch = options.project.base_branch;
    } else {
      this.editProjectId = null;
      this.name = "";
      this.path = "";
      this.baseBranch = "main";
      void this.loadNodes();
    }

    this.dialog.showModal();
    requestAnimationFrame(() => {
      this.renderRoot.querySelector<HTMLInputElement>("input")?.focus();
    });
  }

  close() {
    this.dialog.close();
  }

  /** Lists the nodes; a connected one is chosen when there is one. */
  private async loadNodes() {
    this.nodes = null;
    this.nodeId = "";
    const result = await this.store?.listNodes();
    if (!result) return;
    if ("error" in result) {
      this.error = result.error;
      return;
    }
    this.nodes = result;
    this.nodeId = (result.find((node) => node.connected) ?? result[0])?.id ?? "";
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.name.trim() || !this.path.trim()) {
      this.error = "Name and workspace path are required";
      return;
    }
    if (this.mode === "create" && !this.nodeId) {
      this.error = "Choose the node the checkout is on";
      return;
    }

    this.submitting = true;
    this.error = "";

    try {
      if (this.mode === "create") {
        await this.createProject();
      } else {
        await this.updateProject();
      }
    } catch (err: any) {
      this.error = err.message || "Network error";
    }

    this.submitting = false;
  }

  private async createProject() {
    if (!this.store) return;
    const result = await this.store.createProject({
      name: this.name.trim(),
      path: this.path.trim(),
      nodeId: this.nodeId,
      base_branch: this.baseBranch.trim() || "main",
    });
    if ("error" in result) {
      this.error = result.error;
      return;
    }
    this.close();
    this.dispatchEvent(projectCreatedEvent(result));
  }

  private async updateProject() {
    if (!this.store || this.editProjectId == null) return;
    const result = await this.store.updateProject(this.editProjectId, {
      name: this.name.trim(),
      path: this.path.trim(),
      base_branch: this.baseBranch.trim() || "main",
    });
    if ("error" in result) {
      this.error = result.error;
      return;
    }
    this.close();
    this.dispatchEvent(projectUpdatedEvent());
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target === this.dialog) {
      this.close();
    }
  }

  private get dialogTitle() {
    return this.mode === "create" ? "Add Project" : "Edit Project";
  }

  private get submitLabel() {
    if (this.submitting) return this.mode === "create" ? "Adding..." : "Saving...";
    return this.mode === "create" ? "Add" : "Save";
  }

  private renderNode() {
    return html`
      <div>
        <label class="block text-[10px] text-zinc-400 mb-1">Node</label>
        ${this.nodes === null ? html`<p class="text-[10px] text-zinc-500">Loading nodes…</p>` : html`
          <select
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors cursor-pointer appearance-none"
            @change=${(e: Event) => { if (e.target instanceof HTMLSelectElement) this.nodeId = e.target.value; }}
          >
            ${this.nodes.map((node) => html`<option value=${node.id} ?selected=${node.id === this.nodeId}>${node.connected ? node.name : `${node.name} (offline)`}</option>`)}
          </select>
        `}
      </div>
    `;
  }

  override render() {
    return html`
      <dialog
        class="bg-transparent p-0 m-auto max-h-dvh overflow-hidden backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        @click=${this.handleBackdropClick}
      >
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-96 p-4">
          <h3 class="text-sm font-medium text-zinc-200 mb-3">${this.title}</h3>

          <form @submit=${this.handleSubmit} class="space-y-2">
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Name</label>
              <input
                type="text"
                placeholder="My Project"
                class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                       placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
                .value=${this.name}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.name = e.target.value; }}
              />
            </div>

            ${this.mode === "create" ? this.renderNode() : nothing}

            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Workspace path</label>
              <input
                type="text"
                placeholder="/path/to/project"
                class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                       placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
                .value=${this.path}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.path = e.target.value; }}
              />
            </div>

            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Base branch</label>
              <input
                type="text"
                placeholder="main"
                class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                       placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
                .value=${this.baseBranch}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.baseBranch = e.target.value; }}
              />
            </div>

            ${this.error ? html`
              <div class="text-[10px] text-red-400">${this.error}</div>
            ` : nothing}

            <div class="flex items-center gap-2 pt-1 justify-end">
              <button
                type="button"
                class="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${() => this.close()}
              >Cancel</button>
              <button
                type="submit"
                class="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                ?disabled=${this.submitting}
              >${this.submitLabel}</button>
            </div>
          </form>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "project-form": ProjectForm;
  }
}
