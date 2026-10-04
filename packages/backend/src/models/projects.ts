/**
 * Project Model
 *
 * Business logic for the project's own data: its name and base branch, tasks and code reviews,
 * orchestrating store calls and WebSocket broadcasts. Where its code is lives on its sources (checkouts
 * on nodes, `sources.ts`): a project model works in one of them, the source the call names.
 *
 * `createProject()` remains a standalone function (pre-project context).
 * For project-scoped operations, construct a `ProjectModel` instance.
 */

import {
  createProject as storeCreateProject,
  deleteProject,
  getProject,
  updateProject,
  type Project,
} from "../project-store.js";
import type { NodeHub } from "../state.js";
import { isNodeUnavailable } from "../errors.js";
import type { Broadcast } from "./broadcast.js";
import { ProjectTasks } from "./tasks.js";
import { ProjectCodeReviews } from "./code-reviews.js";
import { createSource, SourceNotFoundError, type SourceModel } from "./sources.js";

// ---------------------------------------------------------------------------
// Create project (standalone — no project context needed)
// ---------------------------------------------------------------------------

export interface CreateProjectParams {
  name: string;
  /** The first checkout's path on its node. */
  path: string;
  /** The node holding that checkout. */
  nodeId: string;
  base_branch?: string;
}

/**
 * Create a project and its first source, the checkout at `path` on node `nodeId` (`createSource`: the
 * node must confirm it). Without a base branch, it is detected in that checkout: `main` when it has none
 * of the candidates or is not a repository. When the source is refused (or its node is unreachable) the
 * project is not kept.
 *
 * Throws on failure — callers map to HTTP responses.
 */
export async function createProject(params: CreateProjectParams, nodes: Pick<NodeHub, "get">): Promise<Project> {
  const project = storeCreateProject(params.name, params.base_branch || "main");
  try {
    const source = await createSource(project.id, params.nodeId, params.path, nodes);
    if (params.base_branch) return project;
    const baseBranch = await source.git.detectDefaultBranch()
      .catch((error: unknown) => {
        if (isNodeUnavailable(error)) throw error;
        return "main";
      });
    return updateProject(project.id, { base_branch: baseBranch }) ?? project;
  } catch (error) {
    deleteProject(project.id);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ProjectModel
// ---------------------------------------------------------------------------

export class ProjectModel {
  readonly baseBranch: string;

  /** `source` is the checkout this call works in (`resolveSource`): tasks create and remove their
   * branches there, and routes read it for files, diffs and git. */
  constructor(
    readonly projectId: number,
    private broadcast: Broadcast,
    readonly source: SourceModel,
  ) {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (source.record.project_id !== projectId) throw new SourceNotFoundError();
    this.baseBranch = project.base_branch;
  }

  /** Files and diffs of the source's checkout, against the project's base branch. */
  get workspace() {
    return this.source.workspace(this.baseBranch);
  }

  /**
   * Return a ProjectTasks instance for task lifecycle operations.
   */
  tasks(): ProjectTasks {
    return new ProjectTasks(
      this.projectId,
      this.source.git,
      this.baseBranch,
      this.broadcast,
    );
  }

  /** Project-scoped code-review operations shared by HTTP and agent callers. */
  codeReviews(): ProjectCodeReviews {
    return new ProjectCodeReviews(this.projectId, this.broadcast);
  }
}
