/**
 * Project Sidebar
 *
 * Thin header component with an "Add Project" button and the project-form
 * modal. The project list itself is rendered inline in session-sidebar as
 * collapsible project sections.
 */

import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { ProjectInfo } from "./ws-client.js";
import type { AppStore } from "./stores/app-store.js";
import type { ProjectForm } from "./project-form.js";
import "./project-form.js";

@customElement("project-sidebar")
export class ProjectSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The app store — provides mutation methods. */
  @property({ attribute: false })
  store: AppStore | null = null;

  @query("project-form") private projectForm!: ProjectForm;

  private _unsubscribe: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("store")) {
      this._subscribe();
    }
  }

  private _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = this.store?.subscribe(() => {
      this.requestUpdate();
    }) ?? null;
  }

  private openAddForm() {
    this.projectForm.open({ mode: "create" });
  }

  /** Open the edit form for a project (called from session-sidebar). */
  openEdit(project: ProjectInfo) {
    this.projectForm.open({ mode: "edit", project });
  }

  private handleProjectCreated(e: CustomEvent<{ project: ProjectInfo }>) {
    location.hash = `#/project/${e.detail.project.id}`;
  }

  private handleProjectUpdated() {
    // Store already refreshed the project list during updateProject()
  }

  override render() {
    return html`
      <div
        @project-created=${this.handleProjectCreated}
        @project-updated=${this.handleProjectUpdated}
      >
        <div class="p-2">
          <button
            class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
            @click=${this.openAddForm}
          >
            + Add Project
          </button>
        </div>
        <project-form .store=${this.store}></project-form>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "project-sidebar": ProjectSidebar;
  }
}
