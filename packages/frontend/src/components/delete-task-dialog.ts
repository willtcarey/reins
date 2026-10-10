/**
 * Delete Task Dialog
 *
 * A confirmation modal dialog for deleting a task, shown while `task` is
 * set. Shows task details and dispatches `confirm-delete` or `cancel-delete`
 * events (Cancel, Escape and the backdrop all cancel). Focus starts on
 * Cancel: deleting a task also deletes its sessions and branch.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TaskWithDiffStats as TaskListItem } from "@backend/models/tasks.js";
import { dialogButton } from "../ui/dialog.js";
import { cancelDeleteEvent, confirmDeleteEvent } from "./events.js";

@customElement("delete-task-dialog")
export class DeleteTaskDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  task: TaskListItem | null = null;

  private handleCancel = () => {
    this.dispatchEvent(cancelDeleteEvent());
  };

  private handleConfirm = () => {
    if (!this.task) return;
    this.dispatchEvent(confirmDeleteEvent(this.task.id));
  };

  override render() {
    const task = this.task;

    return html`
      <app-dialog
        .open=${task !== null}
        heading="Delete Task"
        .body=${task ? html`
          <p class="text-xs text-zinc-300 mb-1">
            Are you sure you want to delete this task?
          </p>
          <div class="bg-zinc-900 rounded px-3 py-2 mb-3">
            <div class="text-xs text-zinc-200 font-medium">${task.title}</div>
            ${task.description ? html`<div class="text-[11px] text-zinc-400 mt-1">${task.description}</div>` : nothing}
            <div class="text-[10px] text-zinc-500 mt-1.5">
              Branch: <span class="text-zinc-400 font-mono">${task.branch_name}</span>
              · ${task.session_count} session${task.session_count !== 1 ? "s" : ""}
            </div>
          </div>
          <p class="text-[11px] text-zinc-400">
            This will permanently delete the task, all its sessions, and the git branch
            <span class="font-mono text-zinc-300">${task.branch_name}</span>.
          </p>
        ` : nothing}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: this.handleCancel, autofocus: true })}
          ${dialogButton({ label: "Delete", variant: "destructive", onClick: this.handleConfirm })}
        `}
        @dialog-cancel=${this.handleCancel}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "delete-task-dialog": DeleteTaskDialog;
  }
}
