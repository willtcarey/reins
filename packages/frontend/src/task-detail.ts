/**
 * Task Detail Dialog
 *
 * Modal dialog for viewing and editing a task's title and description.
 * Opens from the task list's edit button.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { TaskListItem } from "./ws-client.js";

@customElement("task-detail")
export class TaskDetail extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private task: TaskListItem | null = null;
  @state() private title = "";
  @state() private description = "";
  @state() private saving = false;
  @state() private dirty = false;

  @query("dialog") private dialog!: HTMLDialogElement;

  /** Open the dialog for a given task. */
  open(task: TaskListItem) {
    this.task = task;
    this.title = task.title;
    this.description = task.description ?? "";
    this.dirty = false;
    this.saving = false;
    this.dialog.showModal();
    requestAnimationFrame(() => {
      this.renderRoot.querySelector<HTMLInputElement>("input")?.focus();
    });
  }

  /** Close the dialog. */
  close() {
    this.dialog.close();
  }

  private handleInput() {
    if (!this.task) return;
    this.dirty =
      this.title !== this.task.title ||
      this.description !== (this.task.description ?? "");
  }

  private handleSave() {
    if (!this.task || !this.dirty) return;
    if (!this.title.trim()) return;

    this.saving = true;
    this.dispatchEvent(
      new CustomEvent("save-task", {
        bubbles: true,
        composed: true,
        detail: {
          taskId: this.task.id,
          title: this.title.trim(),
          description: this.description.trim() || null,
        },
      }),
    );
  }

  /** Called by the parent after the store completes (or fails) the save. */
  saveComplete(error?: string) {
    this.saving = false;
    if (error) {
      alert(error);
    } else {
      this.close();
    }
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target === this.dialog) {
      this.close();
    }
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.handleSave();
    }
    if (e.key === "Escape") {
      this.close();
    }
  }

  override render() {
    const task = this.task;

    return html`
      <dialog
        class="bg-transparent p-0 m-auto max-h-dvh overflow-hidden backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        @click=${this.handleBackdropClick}
      >
        <div
          class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-[28rem] p-4"
          @keydown=${this.handleKeydown}
        >
          <h3 class="text-sm font-medium text-zinc-200 mb-3">Edit Task</h3>

          <label class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">Title</label>
          <input
            type="text"
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            placeholder="Task title"
            .value=${this.title}
            @input=${(e: Event) => { this.title = (e.target as HTMLInputElement).value; this.handleInput(); }}
          />

          <label class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1 mt-3">Description</label>
          <textarea
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors resize-none"
            rows="5"
            placeholder="Task description (optional)"
            .value=${this.description}
            @input=${(e: Event) => { this.description = (e.target as HTMLTextAreaElement).value; this.handleInput(); }}
          ></textarea>

          ${task ? html`
            <div class="mt-3 text-[10px] text-zinc-500">
              Branch: <span class="font-mono text-zinc-400">${task.branch_name}</span>
            </div>
          ` : nothing}

          <div class="flex items-center gap-2 mt-4 justify-end">
            <span class="text-[10px] text-zinc-500 mr-auto">${this.saving ? "Saving..." : this.dirty ? "⌘↵ to save" : ""}</span>
            <button
              class="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${() => this.close()}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              @click=${this.handleSave}
              ?disabled=${this.saving || !this.dirty || !this.title.trim()}
            >
              ${this.saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-detail": TaskDetail;
  }
}
