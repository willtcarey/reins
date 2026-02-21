/**
 * Project Sidebar
 *
 * Displays at the top of the sidebar. Shows a project switcher dropdown
 * and buttons to add/edit projects. Project creation and editing happen
 * in a modal dialog (project-form).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import type { ProjectInfo } from "./ws-client.js";
import type { ProjectForm } from "./project-form.js";
import "./project-form.js";

@customElement("project-sidebar")
export class ProjectSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Current project ID from the URL route. Null = no project selected. */
  @property({ type: Number })
  activeProjectId: number | null = null;

  @state() private projects: ProjectInfo[] = [];
  @state() private loading = false;
  @state() private dropdownOpen = false;

  @query("project-form") private projectForm!: ProjectForm;

  override connectedCallback() {
    super.connectedCallback();
    this.refresh();

    this._onDocClick = this._onDocClick.bind(this);
    document.addEventListener("click", this._onDocClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._onDocClick);
  }

  private _onDocClick(e: MouseEvent) {
    if (this.dropdownOpen) {
      const el = e.target as HTMLElement;
      if (!this.contains(el)) {
        this.dropdownOpen = false;
      }
    }
  }

  async refresh() {
    this.loading = true;
    try {
      const resp = await fetch("/api/projects");
      if (resp.ok) {
        this.projects = await resp.json();
      }
    } catch {
      // silent
    }
    this.loading = false;
  }

  private get activeProject(): ProjectInfo | null {
    if (this.activeProjectId == null) return null;
    return this.projects.find(p => p.id === this.activeProjectId) ?? null;
  }

  private get activeProjectLabel(): string {
    const proj = this.activeProject;
    if (proj) return proj.name;
    return "Select a project";
  }

  private handleSelectProject(project: ProjectInfo) {
    this.dropdownOpen = false;
    if (project.id === this.activeProjectId) return;
    location.hash = `#/project/${project.id}`;
  }

  private toggleDropdown(e: Event) {
    e.stopPropagation();
    this.dropdownOpen = !this.dropdownOpen;
  }

  private openAddForm() {
    this.dropdownOpen = false;
    this.projectForm.open({ mode: "create" });
  }

  private openEditForm(e: Event, project: ProjectInfo) {
    e.stopPropagation();
    this.dropdownOpen = false;
    this.projectForm.open({ mode: "edit", project });
  }

  private async handleProjectCreated(e: CustomEvent<{ project: ProjectInfo }>) {
    await this.refresh();
    location.hash = `#/project/${e.detail.project.id}`;
  }

  private async handleProjectUpdated() {
    await this.refresh();
  }

  private async handleDeleteProject(e: Event, project: ProjectInfo) {
    e.stopPropagation();
    if (!confirm(`Remove "${project.name}" from REINS?\n\nThis won't delete any files on disk.`)) return;

    try {
      await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      // If we deleted the active project, go back to default
      if (project.id === this.activeProjectId) {
        location.hash = "";
      }
      await this.refresh();
    } catch {}
  }

  override render() {
    return html`
      <div class=""
        @project-created=${this.handleProjectCreated}
        @project-updated=${this.handleProjectUpdated}
      >
        <!-- Project selector button -->
        <div class="relative">
          <button
            class="w-full flex items-center justify-between px-3 py-2.5 text-left cursor-pointer
                   hover:bg-zinc-700/30 transition-colors"
            @click=${this.toggleDropdown}
          >
            <div class="flex items-center gap-2 min-w-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                   class="text-zinc-500 shrink-0">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
              </svg>
              <span class="text-sm text-zinc-200 truncate font-medium">${this.activeProjectLabel}</span>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                 class="text-zinc-500 shrink-0 transition-transform ${this.dropdownOpen ? "rotate-180" : ""}">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>

          <!-- Dropdown -->
          ${this.dropdownOpen ? html`
            <div class="absolute left-0 right-0 top-full z-50 bg-zinc-800 border border-zinc-600 rounded-b shadow-xl max-h-72 overflow-y-auto">
              ${this.projects.map(p => html`
                <button
                  class="w-full flex items-center justify-between px-3 py-2 text-left cursor-pointer
                         transition-colors group
                         ${p.id === this.activeProjectId ? "bg-zinc-700/60" : "hover:bg-zinc-700/30"}"
                  @click=${() => this.handleSelectProject(p)}
                >
                  <div class="min-w-0">
                    <div class="text-xs text-zinc-200 truncate">${p.name}</div>
                    <div class="text-[10px] text-zinc-500 truncate">${p.path}</div>
                    <div class="text-[10px] text-zinc-600 truncate">base: ${p.base_branch}</div>
                  </div>
                  <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      class="p-1 text-zinc-600 hover:text-zinc-200 cursor-pointer"
                      @click=${(e: Event) => this.openEditForm(e, p)}
                      title="Edit project"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
                      </svg>
                    </button>
                    <button
                      class="p-1 text-zinc-600 hover:text-red-400 cursor-pointer"
                      @click=${(e: Event) => this.handleDeleteProject(e, p)}
                      title="Remove project"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                      </svg>
                    </button>
                  </div>
                </button>
              `)}

              <button
                class="w-full px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/30
                       text-left cursor-pointer transition-colors border-t border-zinc-700"
                @click=${this.openAddForm}
              >
                + Add Project
              </button>
            </div>
          ` : nothing}
        </div>

        <!-- Project form modal (shared for create and edit) -->
        <project-form></project-form>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "project-sidebar": ProjectSidebar;
  }
}
