/**
 * Project Store
 *
 * Reactive store for the project list — fetching, creating, updating,
 * and deleting projects. Owns the array of all known projects,
 * independent of which project is currently selected.
 */

import type { ProjectInfo } from "../ws-client.js";

export type ProjectStoreListener = () => void;

export class ProjectStore {
  // ---- Public reactive state ------------------------------------------------

  projects: ProjectInfo[] = [];

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ProjectStoreListener>();

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Actions --------------------------------------------------------------

  /** Fetch the project list from the server. */
  async fetchProjects(): Promise<void> {
    try {
      const resp = await fetch("/api/projects");
      if (resp.ok) {
        this.projects = await resp.json();
        this.notify();
      }
    } catch {
      // silent
    }
  }

  /** Delete a project and refresh the list. */
  async deleteProject(projectId: number): Promise<void> {
    try {
      await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      await this.fetchProjects();
    } catch {
      // silent
    }
  }

  /** Create a new project. Returns the created project on success. */
  async createProject(data: {
    name: string;
    path: string;
    base_branch: string;
  }): Promise<ProjectInfo | { error: string }> {
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to create project" };
      }
      const project: ProjectInfo = await resp.json();
      await this.fetchProjects();
      return project;
    } catch {
      return { error: "Network error" };
    }
  }

  /** Update a project's properties. */
  async updateProject(
    projectId: number,
    data: { name: string; path: string; base_branch: string },
  ): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to update project" };
      }
      await this.fetchProjects();
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }
}
