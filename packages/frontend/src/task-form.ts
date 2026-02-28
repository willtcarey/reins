/**
 * Task Form Dialog
 *
 * Modal dialog for creating a new task within a project.
 * Single text input — task generation goes through AppStore, which
 * calls the backend and auto-refreshes the task list on success.
 */

import { LitElement, html } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { AppStore } from "./stores/app-store.js";

@customElement("task-form")
export class TaskForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: AppStore | null = null;

  @state() private _projectId: number | null = null;

  @state() private prompt = "";
  @state() private creating = false;

  @query("dialog") private dialog!: HTMLDialogElement;

  /** Open the dialog as a modal for a specific project. */
  open(projectId: number) {
    this._projectId = projectId;
    this.prompt = "";
    this.dialog.showModal();
    requestAnimationFrame(() => {
      this.renderRoot.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
  }

  /** Close the dialog. */
  close() {
    this.dialog.close();
  }

  private async handleCreate() {
    if (this._projectId == null || !this.prompt.trim() || !this.store) return;
    this.creating = true;
    const result = await this.store.generateTask(this._projectId, this.prompt.trim());
    if ("ok" in result) {
      this.prompt = "";
      this.close();
    } else {
      alert(result.error);
    }
    this.creating = false;
  }

  private handleBackdropClick(e: MouseEvent) {
    if (e.target === this.dialog) {
      this.close();
    }
  }

  override render() {
    return html`
      <dialog
        class="bg-transparent p-0 m-auto max-h-dvh overflow-hidden backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        @click=${this.handleBackdropClick}
      >
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-96 p-4">
          <h3 class="text-sm font-medium text-zinc-200 mb-3">New Task</h3>

          <textarea
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors resize-none"
            rows="3"
            placeholder="What do you want to do?"
            .value=${this.prompt}
            @input=${(e: Event) => this.prompt = (e.target as HTMLTextAreaElement).value}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.handleCreate(); }
              if (e.key === "Escape") { this.close(); }
            }}
          ></textarea>

          <div class="flex items-center gap-2 mt-3 justify-end">
            <span class="text-[10px] text-zinc-500 mr-auto">${this.creating ? "Generating task..." : "⌘↵ to create"}</span>
            <button
              class="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${() => this.close()}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              @click=${this.handleCreate}
              ?disabled=${this.creating || !this.prompt.trim()}
            >
              ${this.creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-form": TaskForm;
  }
}
