/**
 * Project Model
 *
 * Projects (`Projects`, `Models.projects`): making, changing and deleting them. One project's own data
 * (`ProjectModel`): its tasks and code reviews, and its default source, the only location a project has
 * (its sessions work wherever they are placed: `SessionModel`). Each tells browsers of what it changed,
 * the nodes' sources in use included (`Nodes.watchSources`).
 */

import {
  createProject as storeCreateProject,
  deleteProject,
  getProject,
  updateProject,
  type Project,
} from "../project-store.js";
import { isNodeUnavailable } from "../errors.js";
import type { Broadcast } from "./broadcast.js";
import { ProjectTasks } from "./tasks.js";
import { ProjectCodeReviews } from "./code-reviews.js";
import { defaultSourceOf, ensureSource, SourceModel } from "./sources.js";
import type { Nodes } from "./nodes.js";
import { sessionIdsIn } from "../sessions/session-ownership.js";
import { closeSessionRuntimes } from "../session-runtime/live.js";

export class ProjectNotFoundError extends Error {
  constructor(projectId: number) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export interface CreateProjectParams {
  name: string;
  /** Its default source: the checkout's path on node `nodeId`. */
  path: string;
  nodeId: string;
  base_branch?: string;
}

/** A project's changes: its name (trimmed, not blank), its base branch, its default source's location. */
export interface ProjectChanges {
  name?: string;
  baseBranch?: string;
  defaultSource?: { nodeId: string; path: string };
}

/** The server's projects, on `nodes` (whose broadcast tells browsers). */
export class Projects {
  constructor(private readonly nodes: Nodes) {}

  /**
   * Makes a project whose default source is the checkout at `path` on node `nodeId` (`ensureSource`: a
   * location not known yet must be a directory there). Without a base branch, it is detected in that
   * checkout: `main` when it has none of the candidates or is not a repository. Nothing is kept when the
   * location is refused or its node is unreachable (a location it made stays: it belongs to no project).
   * Throws as `ensureSource` does.
   */
  async create(params: CreateProjectParams): Promise<Project> {
    const source = await ensureSource(params.nodeId, params.path, this.nodes);
    const baseBranch = params.base_branch || await source.git.detectDefaultBranch()
      .catch((error: unknown) => {
        if (isNodeUnavailable(error)) throw error;
        return "main";
      });
    const sources = this.nodes.watchSources();
    const project = storeCreateProject(params.name, baseBranch, source.id);
    sources.publishChanged();
    return project;
  }

  /**
   * Changes the project: a new default source is the checkout at its location (`ensureSource`; its
   * sessions stay where they are). Throws `ProjectNotFoundError`, `Error` for a blank name, and as
   * `ensureSource` does (then nothing changes).
   */
  async update(projectId: number, changes: ProjectChanges): Promise<Project> {
    if (!getProject(projectId)) throw new ProjectNotFoundError(projectId);
    if (changes.name !== undefined && !changes.name.trim()) throw new Error("name cannot be empty");
    const source = changes.defaultSource && await ensureSource(changes.defaultSource.nodeId, changes.defaultSource.path, this.nodes);
    const sources = this.nodes.watchSources();
    const updated = updateProject(projectId, {
      ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      ...(changes.baseBranch === undefined ? {} : { base_branch: changes.baseBranch.trim() || "main" }),
      ...(source ? { default_source_id: source.id } : {}),
    });
    if (!updated) throw new ProjectNotFoundError(projectId);
    sources.publishChanged();
    return updated;
  }

  /** Deletes the project with its tasks and sessions; their live runtimes are closed first (aborting their
   * runs). Throws `ProjectNotFoundError`. */
  async delete(projectId: number): Promise<void> {
    if (!getProject(projectId)) throw new ProjectNotFoundError(projectId);
    await closeSessionRuntimes(this.nodes.state.process, sessionIdsIn({ projectId }));
    const sources = this.nodes.watchSources();
    if (!deleteProject(projectId)) throw new ProjectNotFoundError(projectId);
    sources.publishChanged();
  }
}

// ---------------------------------------------------------------------------
// ProjectModel
// ---------------------------------------------------------------------------

export class ProjectModel {
  readonly baseBranch: string;

  /** The project's default source, the only location a project has: where the work no session does runs
   * (task lists' diff stats, deleting a task's branch, a generated task's utility session), whoever asks. A
   * session's own work runs in its source (`SessionModel`). Throws `SourceNotFoundError` without one. */
  readonly defaultSource: SourceModel;

  constructor(
    readonly projectId: number,
    private readonly nodes: Nodes,
  ) {
    const project = getProject(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    this.baseBranch = project.base_branch;
    this.defaultSource = new SourceModel(nodes.hub, defaultSourceOf(projectId));
  }

  private get broadcast(): Broadcast { return this.nodes.broadcast; }

  /**
   * Return a ProjectTasks instance for task lifecycle operations.
   */
  tasks(): ProjectTasks {
    return new ProjectTasks(
      this.projectId,
      this.defaultSource.git,
      this.baseBranch,
      this.nodes,
    );
  }

  /** Project-scoped code-review operations shared by HTTP and agent callers. */
  codeReviews(): ProjectCodeReviews {
    return new ProjectCodeReviews(this.projectId, this.broadcast);
  }
}
