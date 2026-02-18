/**
 * Branch Indicator
 *
 * Displays the current git branch for the active session.
 * Task sessions show the task's branch; non-task sessions show the
 * project's base branch. Fetches branch info on its own when
 * projectId or taskId changes.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("branch-indicator")
export class BranchIndicator extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Number }) projectId: number | null = null;
  @property({ type: Number }) taskId: number | null = null;
  @property({ type: String }) baseBranch: string | null = null;

  @state() private branch: string | null = null;

  /** Track which fetch is current so stale responses are discarded. */
  private _fetchId = 0;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("projectId") || changed.has("taskId") || changed.has("baseBranch")) {
      this.resolveBranch();
    }
  }

  private async resolveBranch() {
    const fetchId = ++this._fetchId;
    const { projectId, taskId } = this;

    if (projectId == null) {
      this.branch = null;
      return;
    }

    if (taskId) {
      try {
        const resp = await fetch(
          `/api/projects/${projectId}/tasks/${taskId}`
        );
        if (fetchId !== this._fetchId) return; // stale
        if (resp.ok) {
          const task = await resp.json();
          this.branch = task.branch_name ?? null;
          return;
        }
      } catch {
        if (fetchId !== this._fetchId) return;
      }
    }

    // Non-task session or task fetch failed — fall back to base branch
    this.branch = this.baseBranch;
  }

  override render() {
    if (!this.branch) return nothing;

    return html`
      <div class="flex items-center gap-1.5 px-3 text-xs text-zinc-400 border-r border-zinc-700 self-stretch">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             class="shrink-0">
          <line x1="6" y1="3" x2="6" y2="15"></line>
          <circle cx="18" cy="6" r="3"></circle>
          <circle cx="6" cy="18" r="3"></circle>
          <path d="M18 9a9 9 0 0 1-9 9"></path>
        </svg>
        <span class="truncate max-w-[200px]">${this.branch}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "branch-indicator": BranchIndicator;
  }
}
