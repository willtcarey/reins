/**
 * Task Form
 *
 * Inline form for creating a new task within a project.
 * Dispatches a "task-created" event on success.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("task-form")
export class TaskForm extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number })
  projectId: number | null = null;

  @state() private title = "";
  @state() private description = "";
  @state() private creating = false;

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
        }),
      });
      if (resp.ok) {
        this.title = "";
        this.description = "";
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

  private handleCancel() {
    this.dispatchEvent(new CustomEvent("task-cancelled", { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="p-2 border-b border-zinc-700 bg-zinc-800/50">
        <input
          type="text"
          class="w-full px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          placeholder="Task title"
          .value=${this.title}
          @input=${(e: Event) => this.title = (e.target as HTMLInputElement).value}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.handleCreate(); }
            if (e.key === "Escape") { this.handleCancel(); }
          }}
        />
        <textarea
          class="w-full mt-1.5 px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500 resize-none"
          rows="2"
          placeholder="Description (optional)"
          .value=${this.description}
          @input=${(e: Event) => this.description = (e.target as HTMLTextAreaElement).value}
        ></textarea>
        <div class="flex gap-1.5 mt-1.5">
          <button
            class="flex-1 py-1 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            @click=${this.handleCreate}
            ?disabled=${this.creating || !this.title.trim()}
          >
            ${this.creating ? "Creating..." : "Create Task"}
          </button>
          <button
            class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            @click=${this.handleCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "task-form": TaskForm;
  }
}
