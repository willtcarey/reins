/**
 * Task Form Dialog
 *
 * Modal dialog for creating a new task within a project.
 * Single text input — the workspace supplies view context while ProjectsStore
 * owns task generation and project-list refresh behavior.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WorkspaceStore } from "../models/stores/workspace-store.js";
import { dialogButton } from "../ui/dialog.js";
import { showToast } from "./toast.js";

@customElement("task-form")
export class TaskForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: WorkspaceStore | null = null;

  @state() private _projectId: number | null = null;

  @state() private isOpen = false;
  @state() private prompt = "";
  @state() private creating = false;

  /** Open the dialog as a modal for a specific project. */
  open(projectId: number) {
    this._projectId = projectId;
    this.prompt = "";
    this.isOpen = true;
  }

  /** Close the dialog. */
  close() {
    this.isOpen = false;
  }

  private handleCreate = async () => {
    if (this._projectId == null || !this.prompt.trim() || !this.store || this.creating) return;
    this.creating = true;
    const result = await this.store.generateTask(this._projectId, this.prompt.trim());
    if ("ok" in result) {
      this.prompt = "";
      this.close();
    } else {
      showToast(`Failed to create task: ${result.error}`, "error");
    }
    this.creating = false;
  };

  override render() {
    return html`
      <app-dialog
        .open=${this.isOpen}
        heading="New Task"
        .onSubmit=${() => void this.handleCreate()}
        .body=${html`
          <textarea
            autofocus
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors resize-none"
            rows="3"
            placeholder="What do you want to do?"
            .value=${this.prompt}
            @input=${(e: Event) => { if (e.target instanceof HTMLTextAreaElement) this.prompt = e.target.value; }}
          ></textarea>
        `}
        .actions=${html`
          <span class="text-[10px] text-zinc-500 mr-auto">${this.creating ? "Generating task..." : "⌘↵ to create"}</span>
          ${dialogButton({ label: "Cancel", onClick: () => this.close() })}
          ${dialogButton({ label: this.creating ? "Creating..." : "Create", variant: "primary", type: "submit", disabled: this.creating || !this.prompt.trim() })}
        `}
        @dialog-cancel=${() => this.close()}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-form": TaskForm;
  }
}
