/**
 * Project Form Dialog
 *
 * Modal dialog for creating or editing a project.
 * Supports both modes via open({ mode, project? }). The project's own fields
 * (name, base branch) come first, then its sources: creating one puts its
 * first source on the node chosen; editing one lists its sources, each with
 * its node's status, moves those whose path changed on Save, and adds one on
 * another node from the list's last row.
 * Project mutations go through the route-scoped workspace interface, which
 * delegates project-domain work to ProjectsStore.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project as ProjectInfo } from "@backend/project-store.js";
import type { NodeView } from "@backend/models/node.js";
import type { SourceView } from "@backend/models/sources.js";
import type { NodeStatus } from "../models/stores/nodes-store.js";
import type { WorkspaceStore } from "../models/stores/workspace-store.js";
import { dialogButton } from "../ui/dialog.js";
import { nodeStatusDot } from "../ui/node-status.js";
import { projectCreatedEvent, projectUpdatedEvent } from "./events.js";

/** What the form asks of the workspace: nodes, a project's sources, and the project changes it makes. */
export type ProjectFormStore = Pick<WorkspaceStore, "listNodes" | "listSources" | "createProject" | "updateProject" | "addSource" | "moveSource">;

interface OpenCreateOptions {
  mode: "create";
}

interface OpenEditOptions {
  mode: "edit";
  project: ProjectInfo;
}

const LABEL_CLASS = "block text-[10px] text-zinc-400 mb-1";
const INPUT_CLASS = `px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
  placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors`;
const FIELD_ERROR_CLASS = "mt-1 text-[10px] text-red-400";

const sourceStatus = (source: SourceView): NodeStatus => source.revoked ? "revoked" : source.connected ? "connected" : "offline";

@customElement("project-form")
export class ProjectForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: ProjectFormStore | null = null;

  @state() private isOpen = false;
  @state() private mode: "create" | "edit" = "create";
  @state() private editProjectId: number | null = null;
  @state() private name = "";
  /** A new project's first source: its node and its path there (create only). */
  @state() private path = "";
  @state() private nodes: NodeView[] | null = null;
  @state() private nodeId = "";
  /** The project's sources and their edited paths, by source ID (edit only). */
  @state() private sources: SourceView[] | null = null;
  @state() private sourcePaths: Record<number, string> = {};
  /** Why a source's node refused its new path, by source ID (edit only). */
  @state() private sourceErrors: Record<number, string> = {};
  /** The source being added, from the list's last row (edit only): its node (empty for the default
   * choice, `newSourceNodeId`), its path, and why it was refused. */
  @state() private newSource = { nodeId: "", path: "", error: "" };
  @state() private addingSource = false;
  @state() private baseBranch = "main";
  @state() private error = "";
  @state() private submitting = false;

  /** Open the dialog for creating or editing a project. */
  open(options: OpenCreateOptions | OpenEditOptions) {
    this.mode = options.mode;
    this.error = "";
    this.submitting = false;
    this.sourceErrors = {};
    this.newSource = { nodeId: "", path: "", error: "" };
    this.addingSource = false;

    if (options.mode === "edit") {
      this.editProjectId = options.project.id;
      this.name = options.project.name;
      this.baseBranch = options.project.base_branch;
      void this.loadSources(options.project.id);
      void this.loadNodes();
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

  /** Lists the project's sources, each path editable. */
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

  /** The nodes a source can be added on: those the project has none on (a session moved to a node works
   * in its project's one source there). */
  private get addableNodes(): NodeView[] {
    const taken = new Set(this.sources?.map((source) => source.nodeId));
    return (this.nodes ?? []).filter((node) => !taken.has(node.id));
  }

  /** The node the new source goes on: the one chosen, else a connected addable one when there is one. */
  private get newSourceNodeId(): string {
    const nodes = this.addableNodes;
    if (nodes.some((node) => node.id === this.newSource.nodeId)) return this.newSource.nodeId;
    return (nodes.find((node) => node.connected) ?? nodes[0])?.id ?? "";
  }

  /** Adds the new source; its node confirms the directory first. Refused (or the node offline), the
   * reason shows under the row and the fields stay. Returns whether it was added. */
  private async addSource(): Promise<boolean> {
    if (!this.store || this.editProjectId == null || this.addingSource) return false;
    const nodeId = this.newSourceNodeId;
    const path = this.newSource.path.trim();
    if (!nodeId || !path) {
      this.newSource = { ...this.newSource, error: "Choose the node the source is on and its path" };
      return false;
    }
    this.addingSource = true;
    this.newSource = { ...this.newSource, error: "" };
    const added = await this.store.addSource(this.editProjectId, nodeId, path);
    this.addingSource = false;
    if ("error" in added) {
      this.newSource = { ...this.newSource, error: added.error };
      return false;
    }
    this.sources = [...this.sources ?? [], added];
    this.sourcePaths = { ...this.sourcePaths, [added.id]: added.path };
    this.newSource = { nodeId: "", path: "", error: "" };
    return true;
  }

  private handleSubmit = async () => {
    if (this.submitting) return;
    if (!this.name.trim()) {
      this.error = "Name is required";
      return;
    }
    if (this.mode === "create" && (!this.nodeId || !this.path.trim())) {
      this.error = "Choose the node the source is on and its path";
      return;
    }
    if (this.mode === "edit" && Object.values(this.sourcePaths).some((path) => !path.trim())) {
      this.error = "Source paths cannot be empty";
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
    // Each moved source is confirmed by its node: stop at the first it refuses.
    this.sourceErrors = {};
    for (const source of this.sources ?? []) {
      const path = this.sourcePaths[source.id]?.trim();
      if (!path || path === source.path) continue;
      const moved = await this.store.moveSource(this.editProjectId, source.id, path);
      if ("error" in moved) {
        this.sourceErrors = { [source.id]: moved.error };
        return;
      }
    }
    // A path typed into the new source's row is added too, rather than lost.
    if (this.newSource.path.trim() && !await this.addSource()) return;
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

  /** A path field; with `onEnter`, Enter runs it instead of submitting the form. */
  private renderPathInput(value: string, onInput: (path: string) => void, { label, onEnter, disabled = false }: { label: string; onEnter?: () => void; disabled?: boolean }) {
    return html`
      <input
        type="text"
        placeholder="/path/to/project"
        aria-label=${label}
        class="${INPUT_CLASS} w-full min-w-0 font-mono disabled:opacity-50 disabled:cursor-not-allowed"
        ?disabled=${disabled}
        .value=${value}
        @input=${(e: InputEvent) => { if (e.target instanceof HTMLInputElement) onInput(e.target.value); }}
        @keydown=${onEnter ? (e: KeyboardEvent) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          onEnter();
        } : nothing}
      />
    `;
  }

  private renderNodeSelect(nodes: NodeView[], selected: string, onChange: (nodeId: string) => void) {
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

  /** The sources section: a heading, a hint, and its rows. */
  private renderSourcesSection(heading: string, hint: string, rows: unknown) {
    return html`
      <div class="pt-3 mt-1 border-t border-zinc-700 space-y-2">
        <div>
          <div class="text-xs font-medium text-zinc-200">${heading}</div>
          <p class="text-[10px] text-zinc-500">${hint}</p>
        </div>
        ${rows}
      </div>
    `;
  }

  /** A new project's first source: its node and its path there. */
  private renderFirstSource() {
    return this.renderSourcesSection("Source", "The project's working copy: a directory on a node.", this.nodes === null
      ? html`<p class="text-[10px] text-zinc-500">Loading nodes…</p>`
      : html`
        <div class="flex gap-1.5">
          ${this.renderNodeSelect(this.nodes, this.nodeId, (nodeId) => { this.nodeId = nodeId; })}
          ${this.renderPathInput(this.path, (path) => { this.path = path; }, { label: "Path" })}
        </div>
      `);
  }

  /** One row per source: its node's status, name and (for the first of several) that it is the default,
   * then its path. A revoked node's path cannot be checked there, so it is shown but not editable.
   * (Sources on removed nodes are not listed.) Then the row adding one. */
  private renderSources() {
    const sources = this.sources;
    if (sources === null) return html`<p class="text-[10px] text-zinc-500">Loading sources…</p>`;
    const hint = "Working copies of the project on nodes. New sessions start on the default one.";
    const rows = html`
      ${sources.length === 0
        ? html`<p class="text-[10px] text-zinc-500">No sources: add one on a node to work in this project.</p>`
        : sources.map((source, index) => this.renderSource(source, index === 0 && sources.length > 1))}
      ${this.renderAddSource()}
    `;
    return this.renderSourcesSection("Sources", hint, rows);
  }

  private renderSource(source: SourceView, isDefault: boolean) {
    const status = sourceStatus(source);
    const error = this.sourceErrors[source.id];
    return html`
      <div>
        <div class="flex items-center gap-1.5 mb-1">
          ${nodeStatusDot(status)}
          <span class="text-[11px] text-zinc-300 truncate">${source.nodeName}</span>
          ${isDefault ? html`<span class="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 rounded">default</span>` : nothing}
          ${status === "connected" ? nothing : html`<span class="ml-auto text-[10px] ${status === "revoked" ? "text-red-400/80" : "text-zinc-500"}">${status}</span>`}
        </div>
        ${this.renderPathInput(this.sourcePaths[source.id] ?? "", (path) => { this.sourcePaths = { ...this.sourcePaths, [source.id]: path }; }, { label: `Path on ${source.nodeName}`, disabled: source.revoked })}
        ${error ? html`<div class=${FIELD_ERROR_CLASS}>${error}</div>` : nothing}
      </div>
    `;
  }

  /** Adding a source, offered while the project has no source on some node: a node (one it has none on),
   * the path there, and Add, which adds it at once (Save adds one left typed in, too). */
  private renderAddSource() {
    if (this.nodes === null) return nothing;
    const nodes = this.addableNodes;
    if (nodes.length === 0) return nothing;
    const { path, error } = this.newSource;
    return html`
      <div>
        <label class=${LABEL_CLASS}>Add a source</label>
        <div class="flex gap-1.5">
          ${this.renderNodeSelect(nodes, this.newSourceNodeId, (nodeId) => { this.newSource = { ...this.newSource, nodeId }; })}
          ${this.renderPathInput(path, (typed) => { this.newSource = { ...this.newSource, path: typed }; }, { label: "New source path", onEnter: () => void this.addSource() })}
          ${dialogButton({ label: this.addingSource ? "Adding…" : "Add", disabled: this.addingSource || !path.trim(), onClick: () => void this.addSource() })}
        </div>
        ${error ? html`<div class=${FIELD_ERROR_CLASS}>${error}</div>` : nothing}
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

            ${this.mode === "create" ? this.renderFirstSource() : this.renderSources()}

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
