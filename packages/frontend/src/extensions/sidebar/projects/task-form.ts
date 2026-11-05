/**
 * Task Form Dialog
 *
 * Modal dialog for creating a new task within a project.
 * Single text input: Reins writes the task from it (`reins.tasks.create`).
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Tasks } from "@reins/sdk";
import { dialogButton } from "../../../ui/dialog.js";
import { showToast } from "../../../ui/toast.js";

@customElement("task-form")
export class TaskForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  tasks: Tasks | null = null;

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
    if (this._projectId == null || !this.prompt.trim() || !this.tasks || this.creating) return;
    this.creating = true;
    try {
      await this.tasks.create(this._projectId, this.prompt.trim());
      this.prompt = "";
      this.close();
    } catch (error) {
      showToast(`Failed to create task: ${error instanceof Error ? error.message : String(error)}`, "error");
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
