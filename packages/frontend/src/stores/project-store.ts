/**
 * Project Store
 *
 * Single entry point for all project-related data: the project list,
 * project CRUD mutations, and lazily-created ProjectDataStore instances
 * that hold per-project task/session lists and task mutations.
 *
 * Components subscribe via `subscribe()` to get notified when the
 * project list or any child store changes (notifications bubble up).
 */

import type { ProjectInfo } from "../ws-client.js";
import { ProjectDataStore } from "./project-data-store.js";

export type ProjectStoreListener = () => void;

export class ProjectStore {
  // ---- Public reactive state ------------------------------------------------

  projects: ProjectInfo[] = [];

  // ---- Private state --------------------------------------------------------

  private _stores = new Map<number, ProjectDataStore>();
  private _unsubscribes = new Map<number, () => void>();
  private _listeners = new Set<ProjectStoreListener>();

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Project list actions -------------------------------------------------

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
      this.remove(projectId);
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

  // ---- Per-project data stores ----------------------------------------------

  /**
   * Get or create a ProjectDataStore for a project.
   * Creating does NOT fetch — call ensureLoaded() to trigger a fetch.
   */
  getStore(projectId: number): ProjectDataStore {
    let child = this._stores.get(projectId);
    if (child) return child;

    child = new ProjectDataStore(projectId);
    const unsub = child.subscribe(() => this.notify());
    this._stores.set(projectId, child);
    this._unsubscribes.set(projectId, unsub);
    return child;
  }

  /**
   * Get a store only if it already exists (no creation).
   */
  peekStore(projectId: number): ProjectDataStore | undefined {
    return this._stores.get(projectId);
  }

  /**
   * Ensure a project's data is loaded. Creates the store if needed,
   * then fetches if not yet loaded and not currently loading.
   */
  async ensureLoaded(projectId: number): Promise<void> {
    const child = this.getStore(projectId);
    if (!child.loaded && !child.loading) {
      await child.fetchLists();
    }
  }

  /**
   * Refresh a specific project's data. Re-fetches if the store exists,
   * no-op if it doesn't.
   */
  async refresh(projectId: number): Promise<void> {
    const child = this.peekStore(projectId);
    if (child) {
      await child.fetchLists();
    }
  }

  /**
   * Drop a project data store (e.g. project deleted). Unsubscribes from
   * child notifications and removes from the map.
   */
  remove(projectId: number): void {
    const unsub = this._unsubscribes.get(projectId);
    if (!unsub) return;

    unsub();
    this._unsubscribes.delete(projectId);
    this._stores.delete(projectId);
    this.notify();
  }
}
