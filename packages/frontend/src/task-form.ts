/**
 * Task Form Dialog
 *
 * Modal dialog for creating a new task within a project.
 * Single text input — the backend generates title, description, and branch name
 * from the user's freeform intent.
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

  @state() private prompt = "";
  @state() private creating = false;

  @query("dialog") private dialog!: HTMLDialogElement;

  /** Open the dialog as a modal. */
  open() {
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
    if (this.projectId == null || !this.prompt.trim()) return;
    this.creating = true;
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/tasks/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: this.prompt.trim() }),
      });
      if (resp.ok) {
        this.prompt = "";
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
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-96 p-4">
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
