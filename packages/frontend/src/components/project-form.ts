/**
 * Project Form Dialog
 *
 * Modal dialog for creating or editing a project.
 * Supports both modes via open({ mode, project? }).
 * Project mutations go through the route-scoped workspace interface, which
 * delegates project-domain work to ProjectsStore.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project as ProjectInfo } from "@backend/project-store.js";
import type { NodeView } from "@backend/models/node.js";
import type { SourceView } from "@backend/models/sources.js";
import type { WorkspaceStore } from "../models/stores/workspace-store.js";
import { dialogButton } from "../ui/dialog.js";
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

  @state() private isOpen = false;
  @state() private mode: "create" | "edit" = "create";
  @state() private editProjectId: number | null = null;
  @state() private name = "";
  /** A new project's first checkout: its node and its path there (create only). */
  @state() private path = "";
  @state() private nodes: NodeView[] | null = null;
  @state() private nodeId = "";
  /** The project's checkouts and their edited paths, by source ID (edit only). */
  @state() private sources: SourceView[] | null = null;
  @state() private sourcePaths: Record<number, string> = {};
  @state() private baseBranch = "main";
  @state() private error = "";
  @state() private submitting = false;

  /** Open the dialog for creating or editing a project. */
  open(options: OpenCreateOptions | OpenEditOptions) {
    this.mode = options.mode;
    this.error = "";
    this.submitting = false;

    if (options.mode === "edit") {
      this.editProjectId = options.project.id;
      this.name = options.project.name;
      this.baseBranch = options.project.base_branch;
      void this.loadSources(options.project.id);
    } else {
      this.editProjectId = null;
      this.name = "";
      this.path = "";
      this.baseBranch = "main";
      void this.loadNodes();
    }

    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }

  /** Lists the project's checkouts, each path editable. */
  private async loadSources(projectId: number) {
    this.sources = null;
    this.sourcePaths = {};
    const result = await this.store?.listSources(projectId);
    if (!result) return;
    if ("error" in result) {
      this.error = result.error;
      return;
    }
    this.sources = result;
    this.sourcePaths = Object.fromEntries(result.map((source) => [source.id, source.path]));
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

  private handleSubmit = async () => {
    if (this.submitting) return;
    if (!this.name.trim()) {
      this.error = "Name is required";
      return;
    }
    if (this.mode === "create" && (!this.nodeId || !this.path.trim())) {
      this.error = "Choose the node the checkout is on and its path";
      return;
    }
    if (this.mode === "edit" && Object.values(this.sourcePaths).some((path) => !path.trim())) {
      this.error = "Checkout paths cannot be empty";
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
  };

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
      base_branch: this.baseBranch.trim() || "main",
    });
    if ("error" in result) {
      this.error = result.error;
      return;
    }
    // Each moved checkout is confirmed by its node: stop at the first it refuses.
    for (const source of this.sources ?? []) {
      const path = this.sourcePaths[source.id]?.trim();
      if (!path || path === source.path) continue;
      const moved = await this.store.moveSource(this.editProjectId, source.id, path);
      if ("error" in moved) {
        this.error = `${source.nodeName}: ${moved.error}`;
        return;
      }
    }
    this.close();
    this.dispatchEvent(projectUpdatedEvent());
  }

  private get dialogTitle() {
    return this.mode === "create" ? "Add Project" : "Edit Project";
  }

  private get submitLabel() {
    if (this.submitting) return this.mode === "create" ? "Adding..." : "Saving...";
    return this.mode === "create" ? "Add" : "Save";
  }

  private renderPathInput(value: string, onInput: (path: string) => void) {
    return html`
      <input
        type="text"
        placeholder="/path/to/project"
        class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
               placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
        .value=${value}
        @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) onInput(e.target.value); }}
      />
    `;
  }

  /** One path per checkout, labeled with its node. */
  private renderSources() {
    if (this.sources === null) return html`<p class="text-[10px] text-zinc-500">Loading checkouts…</p>`;
    return this.sources.map((source) => html`
      <div>
        <label class="block text-[10px] text-zinc-400 mb-1">Path on ${source.connected ? source.nodeName : `${source.nodeName} (offline)`}</label>
        ${this.renderPathInput(this.sourcePaths[source.id] ?? "", (path) => { this.sourcePaths = { ...this.sourcePaths, [source.id]: path }; })}
      </div>
    `);
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
      <app-dialog
        .open=${this.isOpen}
        heading=${this.dialogTitle}
        .onSubmit=${() => void this.handleSubmit()}
        .body=${html`
          <div class="space-y-2">
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Name</label>
              <input
                type="text"
                autofocus
                placeholder="My Project"
                class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                       placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
                .value=${this.name}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.name = e.target.value; }}
              />
            </div>

            ${this.mode === "create" ? html`
              ${this.renderNode()}
              <div>
                <label class="block text-[10px] text-zinc-400 mb-1">Workspace path</label>
                ${this.renderPathInput(this.path, (path) => { this.path = path; })}
              </div>
            ` : this.renderSources()}

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
          </div>
        `}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: () => this.close() })}
          ${dialogButton({ label: this.submitLabel, variant: "primary", type: "submit", disabled: this.submitting })}
        `}
        @dialog-cancel=${() => this.close()}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "project-form": ProjectForm;
  }
}
