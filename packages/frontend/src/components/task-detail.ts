/**
 * Task Detail Dialog
 *
 * Modal dialog for viewing and editing a task's title and description.
 * Opens from the task list's edit button.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { TaskWithDiffStats as TaskListItem } from "@backend/models/tasks.js";
import { dialogButton } from "../ui/dialog.js";
import { saveTaskEvent } from "./events.js";
import { showToast } from "./toast.js";

@customElement("task-detail")
export class TaskDetail extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private isOpen = false;
  @state() private task: TaskListItem | null = null;
  @state() private taskTitle = "";
  @state() private description = "";
  @state() private saving = false;
  @state() private dirty = false;

  /** Open the dialog for a given task. */
  open(task: TaskListItem) {
    this.task = task;
    this.taskTitle = task.title;
    this.description = task.description ?? "";
    this.dirty = false;
    this.saving = false;
    this.isOpen = true;
  }

  /** Close the dialog. */
  close() {
    this.isOpen = false;
  }

  private handleInput() {
    if (!this.task) return;
    this.dirty =
      this.taskTitle !== this.task.title ||
      this.description !== (this.task.description ?? "");
  }

  private handleSave = () => {
    if (!this.task || !this.dirty || this.saving) return;
    if (!this.taskTitle.trim()) return;
    this.saving = true;
    this.dispatchEvent(saveTaskEvent({
      taskId: this.task.id,
      title: this.taskTitle.trim(),
      description: this.description.trim() || null,
    }));
  };

  /** Called by the parent after the store completes (or fails) the save; a failure keeps the dialog open. */
  saveComplete(error?: string) {
    this.saving = false;
    if (error) {
      showToast(`Failed to save task: ${error}`, "error");
    } else {
      this.close();
    }
  }

  override render() {
    const task = this.task;

    return html`
      <app-dialog
        .open=${this.isOpen}
        heading="Edit Task"
        width="md"
        .onSubmit=${this.handleSave}
        .body=${html`
          <label class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">Title</label>
          <input
            type="text"
            autofocus
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            placeholder="Task title"
            .value=${this.taskTitle}
            @input=${(e: Event) => { if (e.target instanceof HTMLInputElement) { this.taskTitle = e.target.value; this.handleInput(); } }}
          />

          <label class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1 mt-3">Description</label>
          <textarea
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors resize-none"
            rows="5"
            placeholder="Task description (optional)"
            .value=${this.description}
            @input=${(e: Event) => { if (e.target instanceof HTMLTextAreaElement) { this.description = e.target.value; this.handleInput(); } }}
          ></textarea>

          ${task ? html`
            <div class="mt-3 text-[10px] text-zinc-500">
              Branch: <span class="font-mono text-zinc-400">${task.branch_name}</span>
            </div>
          ` : nothing}
        `}
        .actions=${html`
          <span class="text-[10px] text-zinc-500 mr-auto">${this.saving ? "Saving..." : this.dirty ? "⌘↵ to save" : ""}</span>
          ${dialogButton({ label: "Cancel", onClick: () => this.close() })}
          ${dialogButton({ label: this.saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: this.saving || !this.dirty || !this.taskTitle.trim() })}
        `}
        @dialog-cancel=${() => this.close()}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-detail": TaskDetail;
  }
}
