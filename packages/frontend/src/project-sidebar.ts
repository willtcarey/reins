/**
 * Herald Project Sidebar
 *
 * Displays at the top of the sidebar. Shows a project switcher dropdown
 * and an "Add Project" form. Projects are persisted server-side in SQLite.
 * Switching projects navigates via URL hash — no WebSocket involvement.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ProjectInfo } from "./ws-client.js";

@customElement("herald-projects")
export class HeraldProjects extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Current project ID from the URL route. Null = no project selected. */
  @property({ type: Number })
  activeProjectId: number | null = null;

  @state() private projects: ProjectInfo[] = [];
  @state() private showAddForm = false;
  @state() private addName = "";
  @state() private addPath = "";
  @state() private addBaseBranch = "main";
  @state() private addError = "";
  @state() private loading = false;
  @state() private dropdownOpen = false;

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
    this.showAddForm = true;
    this.dropdownOpen = false;
    this.addName = "";
    this.addPath = "";
    this.addBaseBranch = "main";
    this.addError = "";
  }

  private cancelAdd() {
    this.showAddForm = false;
    this.addError = "";
  }

  private async submitAdd(e: Event) {
    e.preventDefault();
    if (!this.addName.trim() || !this.addPath.trim()) {
      this.addError = "Both name and path are required";
      return;
    }

    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: this.addName.trim(),
          path: this.addPath.trim(),
          base_branch: this.addBaseBranch.trim() || "main",
        }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        this.addError = data.error || "Failed to create project";
        return;
      }
      const project: ProjectInfo = await resp.json();
      this.showAddForm = false;
      await this.refresh();
      // Navigate to the new project
      location.hash = `#/project/${project.id}`;
    } catch (err: any) {
      this.addError = err.message || "Network error";
    }
  }

  private async handleDeleteProject(e: Event, project: ProjectInfo) {
    e.stopPropagation();
    if (!confirm(`Remove "${project.name}" from Herald?\n\nThis won't delete any files on disk.`)) return;

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
      <div class="border-b border-zinc-700">
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
                  <button
                    class="p-1 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    @click=${(e: Event) => this.handleDeleteProject(e, p)}
                    title="Remove project"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                    </svg>
                  </button>
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

        <!-- Add project form (inline) -->
        ${this.showAddForm ? html`
          <form class="px-3 py-2 space-y-2 bg-zinc-800/50" @submit=${this.submitAdd}>
            <input
              type="text"
              placeholder="Project name"
              class="w-full px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-200
                     placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
              .value=${this.addName}
              @input=${(e: InputEvent) => this.addName = (e.target as HTMLInputElement).value}
            />
            <input
              type="text"
              placeholder="/path/to/project"
              class="w-full px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-200
                     placeholder-zinc-500 focus:outline-none focus:border-zinc-500 font-mono"
              .value=${this.addPath}
              @input=${(e: InputEvent) => this.addPath = (e.target as HTMLInputElement).value}
            />
            <input
              type="text"
              placeholder="Base branch (default: main)"
              class="w-full px-2 py-1.5 text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-200
                     placeholder-zinc-500 focus:outline-none focus:border-zinc-500 font-mono"
              .value=${this.addBaseBranch}
              @input=${(e: InputEvent) => this.addBaseBranch = (e.target as HTMLInputElement).value}
            />
            ${this.addError ? html`
              <div class="text-[10px] text-red-400">${this.addError}</div>
            ` : nothing}
            <div class="flex gap-2">
              <button
                type="submit"
                class="flex-1 py-1 px-2 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer transition-colors"
              >Add</button>
              <button
                type="button"
                class="flex-1 py-1 px-2 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded cursor-pointer transition-colors"
                @click=${this.cancelAdd}
              >Cancel</button>
            </div>
          </form>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "herald-projects": HeraldProjects;
  }
}
