/**
 * Delete Task Dialog
 *
 * A confirmation modal dialog for deleting a task. Shows task details and
 * dispatches `confirm-delete` or `cancel-delete` events.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TaskListItem } from "../models/ws-client.js";

@customElement("delete-task-dialog")
export class DeleteTaskDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  task: TaskListItem | null = null;

  private handleCancel() {
    this.dispatchEvent(new CustomEvent("cancel-delete", { bubbles: true, composed: true }));
  }

  private handleConfirm() {
    if (!this.task) return;
    this.dispatchEvent(
      new CustomEvent("confirm-delete", {
        bubbles: true,
        composed: true,
        detail: { taskId: this.task.id },
      }),
    );
  }

  override render() {
    const task = this.task;
    if (!task) return nothing;

    return html`
      <div
        class="fixed inset-0 z-[var(--layer-overlay)] flex items-center justify-center bg-black/60"
        @click=${this.handleCancel}
      >
        <div
          class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl max-w-sm w-full mx-4 p-5"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <h3 class="text-sm font-semibold text-zinc-100 mb-3">Delete Task</h3>
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
          <p class="text-[11px] text-zinc-400 mb-4">
            This will permanently delete the task, all its sessions, and the git branch
            <span class="font-mono text-zinc-300">${task.branch_name}</span>.
          </p>
          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
              @click=${this.handleCancel}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 rounded cursor-pointer transition-colors"
              @click=${this.handleConfirm}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "delete-task-dialog": DeleteTaskDialog;
  }
}
