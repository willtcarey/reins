/**
 * Project Form Dialog
 *
 * Modal dialog for creating or editing a project.
 * Supports both modes via open({ mode, project? }). The project's own fields
 * (name, base branch) come first, then its default source: a node and a path there, where
 * the project is created and its new sessions work unless told otherwise.
 * Changing the default location on Save moves no session. A directory not known yet is
 * checked on its node.
 * It lists nodes and changes projects through the SDK (`reins.nodes`, `reins.projects`).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { NodeSummary, Project, ReinsSdk } from "@reins/sdk";
import { dialogButton } from "../../../ui/dialog.js";
import { projectCreatedEvent, projectUpdatedEvent } from "../../../components/events.js";

/** What the form asks of the SDK: nodes, and the project changes it makes. */
export type ProjectFormSdk = Pick<ReinsSdk, "nodes" | "projects">;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

interface OpenCreateOptions {
  mode: "create";
}

interface OpenEditOptions {
  mode: "edit";
  project: Project;
}

const LABEL_CLASS = "block text-[10px] text-zinc-400 mb-1";
const INPUT_CLASS = `px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
  placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors`;

@customElement("project-form")
export class ProjectForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  reins: ProjectFormSdk | null = null;

  @state() private isOpen = false;
  @state() private mode: "create" | "edit" = "create";
  @state() private editProjectId: number | null = null;
  @state() private name = "";
  /** The project's default source: its node and its path there. */
  @state() private path = "";
  @state() private nodes: readonly NodeSummary[] | null = null;
  @state() private nodeId = "";
  /** The default source it had when the form opened (edit only): Save changes it only when it changed. */
  private savedSource: { nodeId: string; path: string } | null = null;
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
      this.baseBranch = options.project.baseBranch;
      this.savedSource = options.project.defaultSource;
      this.path = options.project.defaultSource?.path ?? "";
    } else {
      this.editProjectId = null;
      this.name = "";
      this.path = "";
      this.baseBranch = "main";
      this.savedSource = null;
    }
    void this.loadNodes();

    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }

  /** Lists the nodes; the default source's is chosen, else a connected one when there is one. */
  private async loadNodes() {
    this.nodes = null;
    this.nodeId = "";
    if (!this.reins) return;
    let result: readonly NodeSummary[];
    try {
      result = await this.reins.nodes.list();
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.nodes = result;
    const saved = this.savedSource && result.find((node) => node.id === this.savedSource?.nodeId);
    this.nodeId = (saved ?? result.find((node) => node.connected) ?? result[0])?.id ?? "";
  }

  private handleSubmit = async () => {
    if (this.submitting) return;
    if (!this.name.trim()) {
      this.error = "Name is required";
      return;
    }
    if (!this.nodeId || !this.path.trim()) {
      this.error = "Choose the node of the project's default source and its path there";
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
    if (!this.reins) return;
    let created: Project;
    try {
      created = await this.reins.projects.create({
        name: this.name.trim(),
        source: { nodeId: this.nodeId, path: this.path.trim() },
        baseBranch: this.baseBranch.trim() || "main",
      });
    } catch (error) {
      this.error = errorMessage(error);
      return;
    }
    this.close();
    this.dispatchEvent(projectCreatedEvent(created));
  }

  private async updateProject() {
    if (!this.reins || this.editProjectId == null) return;
    const defaultSource = { nodeId: this.nodeId, path: this.path.trim() };
    const moved = defaultSource.nodeId !== this.savedSource?.nodeId || defaultSource.path !== this.savedSource?.path;
    try {
      await this.reins.projects.update(this.editProjectId, {
        name: this.name.trim(),
        baseBranch: this.baseBranch.trim() || "main",
        ...(moved ? { defaultSource } : {}),
      });
    } catch (error) {
      this.error = errorMessage(error);
      return;
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

  private renderNodeSelect(nodes: readonly NodeSummary[], selected: string, onChange: (nodeId: string) => void) {
    return html`
      <select
        class="${INPUT_CLASS} w-32 shrink-0 cursor-pointer appearance-none truncate"
        aria-label="Node"
        @change=${(e: Event) => { if (e.target instanceof HTMLSelectElement) onChange(e.target.value); }}
      >
        ${nodes.map((node) => html`<option value=${node.id} ?selected=${node.id === selected}>${node.connected ? node.name : `${node.name} (offline)`}</option>`)}
      </select>
    `;
  }

  /** The project's default source: its node and its path there. */
  private renderDefaultSource() {
    return html`
      <div class="pt-3 mt-1 border-t border-zinc-700 space-y-2">
        <div>
          <div class="text-xs font-medium text-zinc-200">Default location</div>
          <p class="text-[10px] text-zinc-500">A directory on a node: where new sessions of the project work unless told otherwise.${this.mode === "edit" ? " Changing it moves no session." : ""}</p>
        </div>
        ${this.nodes === null
          ? html`<p class="text-[10px] text-zinc-500">Loading nodes…</p>`
          : html`
            <div class="flex gap-1.5">
              ${this.renderNodeSelect(this.nodes, this.nodeId, (nodeId) => { this.nodeId = nodeId; })}
              <input
                type="text"
                placeholder="/path/to/project"
                aria-label="Path"
                class="${INPUT_CLASS} w-full min-w-0 font-mono"
                .value=${this.path}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.path = e.target.value; }}
              />
            </div>
          `}
      </div>
    `;
  }

  override render() {
    return html`
      <app-dialog
        .open=${this.isOpen}
        heading=${this.dialogTitle}
        width="md"
        .onSubmit=${() => void this.handleSubmit()}
        .body=${html`
          <div class="space-y-2">
            <div>
              <label class=${LABEL_CLASS}>Name</label>
              <input
                type="text"
                autofocus
                placeholder="My Project"
                class="${INPUT_CLASS} w-full"
                .value=${this.name}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.name = e.target.value; }}
              />
            </div>

            <div>
              <label class=${LABEL_CLASS}>Base branch</label>
              <input
                type="text"
                placeholder="main"
                class="${INPUT_CLASS} w-full font-mono"
                .value=${this.baseBranch}
                @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) this.baseBranch = e.target.value; }}
              />
            </div>

            ${this.renderDefaultSource()}

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
