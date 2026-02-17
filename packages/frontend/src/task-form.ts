/**
 * Task Form Dialog
 *
 * Modal dialog for creating a new task within a project.
 * Uses the native <dialog> element for popover behavior.
 * Dispatches a "task-created" event on success.
 */

import { LitElement, html } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";

@customElement("task-form")
export class TaskForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @state() private title = "";
  @state() private description = "";
  @state() private branch = "";
  @state() private creating = false;

  @query("dialog") private dialog!: HTMLDialogElement;

  /** Open the dialog as a modal. */
  open() {
    this.title = "";
    this.description = "";
    this.branch = "";
    this.dialog.showModal();
    // Focus the title input after the dialog opens
    requestAnimationFrame(() => {
      this.renderRoot.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
    });
  }

  /** Close the dialog. */
  close() {
    this.dialog.close();
  }

  private async handleCreate() {
    if (this.projectId == null || !this.title.trim()) return;
    this.creating = true;
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: this.title.trim(),
          description: this.description.trim() || undefined,
          branch_name: this.branch.trim() || undefined,
        }),
      });
      if (resp.ok) {
        this.title = "";
        this.description = "";
        this.branch = "";
        this.close();
        this.dispatchEvent(new CustomEvent("task-created", { bubbles: true, composed: true }));
      } else {
        const data = await resp.json().catch(() => ({}));
        alert(data.error || `Error creating task (HTTP ${resp.status})`);
      }
    } catch {
      // silent
    }
    this.creating = false;
  }

  private handleBackdropClick(e: MouseEvent) {
    // Close when clicking the backdrop (the dialog element itself, not its contents)
    if (e.target === this.dialog) {
      this.close();
    }
  }

  override render() {
    return html`
      <dialog
        class="bg-transparent p-0 m-auto backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        @click=${this.handleBackdropClick}
      >
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-80 p-4">
          <h3 class="text-sm font-medium text-zinc-200 mb-3">New Task</h3>

          <input
            type="text"
            class="w-full px-2.5 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            placeholder="Task title"
            .value=${this.title}
            @input=${(e: Event) => this.title = (e.target as HTMLInputElement).value}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleCreate(); }
              if (e.key === "Escape") { this.close(); }
            }}
          />

          <textarea
            class="w-full mt-2 px-2.5 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors resize-none"
            rows="3"
            placeholder="Description (optional)"
            .value=${this.description}
            @input=${(e: Event) => this.description = (e.target as HTMLTextAreaElement).value}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Escape") { this.close(); }
            }}
          ></textarea>

          <input
            type="text"
            class="w-full mt-2 px-2.5 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
            placeholder="Branch name (auto-generated if empty)"
            .value=${this.branch}
            @input=${(e: Event) => this.branch = (e.target as HTMLInputElement).value}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleCreate(); }
              if (e.key === "Escape") { this.close(); }
            }}
          />

          <div class="flex gap-2 mt-3 justify-end">
            <button
              class="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${() => this.close()}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              @click=${this.handleCreate}
              ?disabled=${this.creating || !this.title.trim()}
            >
              ${this.creating ? "Creating..." : "Create Task"}
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
