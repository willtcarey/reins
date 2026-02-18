/**
 * Project Form Dialog
 *
 * Modal dialog for creating or editing a project.
 * Supports both modes via open({ mode, project? }).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state, query } from "lit/decorators.js";
import type { ProjectInfo } from "./ws-client.js";

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

  @state() private mode: "create" | "edit" = "create";
  @state() private editProjectId: number | null = null;
  @state() private name = "";
  @state() private path = "";
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
    }

    this.dialog.showModal();
    requestAnimationFrame(() => {
      this.renderRoot.querySelector<HTMLInputElement>("input")?.focus();
    });
  }

  close() {
    this.dialog.close();
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.name.trim() || !this.path.trim()) {
      this.error = "Name and workspace path are required";
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
    const resp = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: this.name.trim(),
        path: this.path.trim(),
        base_branch: this.baseBranch.trim() || "main",
      }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      this.error = data.error || "Failed to create project";
      return;
    }
    const project: ProjectInfo = await resp.json();
    this.close();
    this.dispatchEvent(new CustomEvent("project-created", {
      bubbles: true, composed: true,
      detail: { project },
    }));
  }

  private async updateProject() {
    const resp = await fetch(`/api/projects/${this.editProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: this.name.trim(),
        path: this.path.trim(),
        base_branch: this.baseBranch.trim() || "main",
      }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      this.error = data.error || "Failed to update project";
      return;
    }
    this.close();
    this.dispatchEvent(new CustomEvent("project-updated", {
      bubbles: true, composed: true,
    }));
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target === this.dialog) {
      this.close();
    }
  }

  private get title() {
    return this.mode === "create" ? "Add Project" : "Edit Project";
  }

  private get submitLabel() {
    if (this.submitting) return this.mode === "create" ? "Adding..." : "Saving...";
    return this.mode === "create" ? "Add" : "Save";
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
                @input=${(e: InputEvent) => this.name = (e.target as HTMLInputElement).value}
              />
            </div>

            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Workspace path</label>
              <input
                type="text"
                placeholder="/path/to/project"
                class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                       placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
                .value=${this.path}
                @input=${(e: InputEvent) => this.path = (e.target as HTMLInputElement).value}
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
                @input=${(e: InputEvent) => this.baseBranch = (e.target as HTMLInputElement).value}
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
