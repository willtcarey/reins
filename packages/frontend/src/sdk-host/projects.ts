/** The SDK's `projects`, `tasks` and `nodes`, over the app's `ProjectsStore`. */

import type { ProjectView } from "@backend/routes/projects.js";
import type { TaskWithDiffStats } from "@backend/models/tasks.js";
import type { NodeSummary, Nodes, Project, ProjectChanges, ProjectCreation, Projects, ProjectsChange, Task, Tasks, TasksChange } from "@reins/sdk";
import { ChangeFeed, Snapshot } from "./change-feed.js";
import type { ProjectsStore } from "../models/stores/projects-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import { sdkActivity } from "./sessions.js";

function unwrap(result: { ok: true } | { error: string }): void {
  if ("error" in result) throw new Error(result.error);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Compares, a microtask after the store changed and while anyone listens, what `read` gives with what listeners
 * last heard, and tells them the keys that changed. The store tells of any change; this narrows it to the
 * changes a read shows.
 */
class Watched<K> {
  private readonly snapshot = new Snapshot<K>();
  private readonly feed = new ChangeFeed<K>();
  private checking = false;

  constructor(store: Pick<ProjectsStore, "subscribe">, private readonly read: () => ReadonlyMap<K, unknown>) {
    store.subscribe(() => {
      if (this.checking || !this.feed.listened) return;
      this.checking = true;
      queueMicrotask(() => {
        this.checking = false;
        this.feed.add(this.snapshot.changed(this.read()));
      });
    });
  }

  listen(listener: (keys: K[]) => void): () => void {
    if (!this.feed.listened) this.snapshot.changed(this.read());
    return this.feed.listen(listener);
  }

  /** Tells listeners of keys that changed without the store knowing what (a project not loaded). */
  add(keys: K[]): void {
    this.feed.add(keys);
  }
}

export class SdkProjects implements Projects {
  private readonly watched: Watched<number>;

  constructor(private readonly store: ProjectsStore) {
    this.watched = new Watched(store, () => new Map(this.list().map((project) => [project.id, project])));
  }

  list(): readonly Project[] {
    return this.store.projects.toSorted(byName).map((project) => this.project(project));
  }

  onDidChange(listener: (change: ProjectsChange) => void): () => void {
    return this.watched.listen((projectIds) => listener({ projectIds }));
  }

  async create({ name, source, baseBranch }: ProjectCreation): Promise<Project> {
    const created = await this.store.createProject({ name, path: source.path, nodeId: source.nodeId, base_branch: baseBranch ?? "" });
    if ("error" in created) throw new Error(created.error);
    return this.project(created);
  }

  async update(projectId: number, { name, baseBranch, defaultSource }: ProjectChanges): Promise<void> {
    unwrap(await this.store.updateProject(projectId, {
      ...(name === undefined ? {} : { name }),
      ...(baseBranch === undefined ? {} : { base_branch: baseBranch }),
      ...(defaultSource ? { defaultSource: { nodeId: defaultSource.nodeId, path: defaultSource.path } } : {}),
    }));
  }

  async remove(projectId: number): Promise<void> {
    unwrap(await this.store.deleteProject(projectId));
  }

  private project(project: ProjectView): Project {
    return {
      id: project.id,
      name: project.name,
      activity: sdkActivity(this.store.activityForProject(project.id)),
      baseBranch: project.base_branch,
      defaultSource: project.defaultSource,
    };
  }
}

export class SdkTasks implements Tasks {
  private readonly watched: Watched<number>;

  /** Watches the tasks of the projects loaded; a task changing in another is told as the server says it. */
  constructor(private readonly store: ProjectsStore) {
    this.watched = new Watched(store, () => new Map(store.projects.flatMap(({ id }) => {
      const project = store.peekStore(id);
      return project ? [[id, { loaded: project.loaded, tasks: project.tasks.map((task) => this.task(project, task)) }]] : [];
    })));
    store.onTasksUpdated((projectId) => this.watched.add([projectId]));
  }

  list(projectId: number): readonly Task[] {
    void this.store.ensureLoaded(projectId);
    const project = this.store.getStore(projectId);
    return project.tasks.map((task) => this.task(project, task));
  }

  loaded(projectId: number): boolean {
    return this.store.peekStore(projectId)?.loaded ?? false;
  }

  onDidChange(listener: (change: TasksChange) => void): () => void {
    return this.watched.listen((projectIds) => listener({ projectIds }));
  }

  async create(projectId: number, request: string): Promise<void> {
    this.store.getStore(projectId);
    unwrap(await this.store.generateTask(projectId, request));
  }

  async update(projectId: number, taskId: number, changes: { title?: string; description?: string | null }): Promise<void> {
    this.store.getStore(projectId);
    unwrap(await this.store.updateTask(projectId, taskId, changes));
  }

  async remove(projectId: number, taskId: number): Promise<void> {
    this.store.getStore(projectId);
    unwrap(await this.store.deleteTask(projectId, taskId));
    await this.store.refresh(projectId);
  }

  private task(project: ProjectStore, task: TaskWithDiffStats): Task {
    return {
      id: task.id,
      projectId: task.project_id,
      title: task.title,
      description: task.description,
      branchName: task.branch_name,
      closed: task.status === "closed",
      updatedAt: task.updated_at,
      sessionCount: task.session_count,
      diffStats: task.diffStats ?? null,
      activity: sdkActivity(project.activityForTask(task.id)),
    };
  }
}

export class SdkNodes implements Nodes {
  constructor(private readonly store: Pick<ProjectsStore, "listNodes">) {}

  async list(): Promise<readonly NodeSummary[]> {
    const nodes = await this.store.listNodes();
    if ("error" in nodes) throw new Error(nodes.error);
    return nodes.map(({ id, name, connected }) => ({ id, name, connected }));
  }
}
