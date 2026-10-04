/**
 * Project Model
 *
 * Business logic for project lifecycle, remote sync, and uploads. Orchestrates
 * store calls, git operations, and WebSocket broadcasts.
 *
 * `createProject()` remains a standalone function (pre-project context).
 * For project-scoped operations, construct a `ProjectModel` instance.
 */

import { resolve, normalize, basename, join } from "path";
import { mkdirSync } from "fs";
import {
  createProject as storeCreateProject,
  deleteProject,
  getProject,
  updateProject,
  type Project,
} from "../project-store.js";
import { listOpenTasks, markTasksClosed } from "../task-store.js";
import { clearFinishedActivityForTasks } from "../session-store.js";
import type { DirectoryEntry } from "@reins/node-protocol";
import { Git } from "../git.js";
import { defaultSource, getNode, getSource, type Source } from "../node-store.js";
import type { NodeHub } from "../state.js";
import { isNodeUnavailable, nodeRefusal } from "../errors.js";
import { Workspace } from "./workspace.js";
import type { ReadFile } from "./file-system.js";
import type { Broadcast } from "./broadcast.js";
import { logger } from "../logger.js";
import { ProjectTasks } from "./tasks.js";
import { ProjectCodeReviews } from "./code-reviews.js";

export type { DirectoryEntry };

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class DuplicateProjectError extends Error {
  constructor(message = "A project with that path already exists") { super(message); }
}

export class PathTraversalError extends Error {
  constructor(message = "Path traversal not allowed") { super(message); }
}

export class FileNotFoundError extends Error {
  constructor(message = "File not found") { super(message); }
}

export class NoFilesError extends Error {
  constructor(message = "No files provided") { super(message); }
}

export class InvalidFilenameError extends Error {
  constructor(message = "Invalid filename") { super(message); }
}

export class SourceNotFoundError extends Error {
  constructor(message = "Source not found") { super(message); }
}

export class NodeNotFoundError extends Error {
  constructor(message = "Node not found") { super(message); }
}

/** A project's checkout path is not a directory on its node. */
export class CheckoutNotFoundError extends Error {}

/**
 * The source a call works in: the one the caller names (a request's `sourceId`, a calling session's
 * source), which must belong to the project, or else the project's default source. Resolve it where the
 * call enters (route middleware, tool scope), not inside models.
 */
export function resolveSource(projectId: number, sourceId?: number | null): Source {
  if (sourceId == null) {
    const source = defaultSource(projectId);
    if (!source) throw new SourceNotFoundError("Project has no source");
    return source;
  }
  const source = getSource(sourceId);
  if (!source || source.project_id !== projectId) throw new SourceNotFoundError();
  return source;
}

/** Bound on the node answering `fs.list` or opening an `fs.read`. */
const FS_REQUEST_TIMEOUT_MS = 10_000;

/** The git of a source's checkout, run on its node. */
function sourceGit(nodes: Pick<NodeHub, "get">, source: Source): Git {
  const node = nodes.get(source.node_id);
  return new Git((argv, options) => node.spawn(argv, { ...options, sourceId: source.id, cwd: source.path }));
}

// ---------------------------------------------------------------------------
// Create project (standalone — no project context needed)
// ---------------------------------------------------------------------------

export interface CreateProjectParams {
  name: string;
  /** The checkout's path on the node. */
  path: string;
  /** The node holding the checkout: the project's first source goes there. */
  nodeId: string;
  base_branch?: string;
}

/**
 * Create a project and its first source (the checkout at `path` on node `nodeId`), translating UNIQUE
 * constraint errors to a descriptive error. The checkout is then checked on its node: a missing directory
 * throws `CheckoutNotFoundError`. Without a base branch, it is detected there: `main` when the checkout
 * has none of the candidates or is not a repository. When a check fails (or the node is unreachable) the
 * project is not kept.
 *
 * Throws on failure — callers map to HTTP responses.
 */
export async function createProject(params: CreateProjectParams, nodes: Pick<NodeHub, "get">): Promise<Project> {
  if (!getNode(params.nodeId)) throw new NodeNotFoundError();
  let project: Project;
  try {
    project = storeCreateProject(params.name, params.path, params.base_branch || "main", params.nodeId);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      throw new DuplicateProjectError();
    }
    throw err;
  }

  try {
    const source = resolveSource(project.id);
    await assertCheckoutExists(nodes, source);
    if (params.base_branch) return project;
    const baseBranch = await sourceGit(nodes, source).detectDefaultBranch()
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

/**
 * Update a project. A new path moves its first source, so it is checked on that source's node first: a
 * missing directory throws `CheckoutNotFoundError`. Returns null when the project does not exist.
 */
export async function editProject(
  projectId: number,
  updates: { name?: string; path?: string; base_branch?: string },
  nodes: Pick<NodeHub, "get">,
): Promise<Project | null> {
  if (!getProject(projectId)) return null;
  if (updates.path !== undefined) await assertCheckoutExists(nodes, { ...resolveSource(projectId), path: updates.path });
  return updateProject(projectId, updates);
}

/** Throws `CheckoutNotFoundError` unless the source's path is a directory on its node. */
async function assertCheckoutExists(nodes: Pick<NodeHub, "get">, source: Source): Promise<void> {
  try {
    await nodes.get(source.node_id).request("fs.list", { sourceId: source.id, cwd: source.path, path: "." }, { timeoutMs: FS_REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (nodeRefusal(error)?.code === "not_found") throw new CheckoutNotFoundError(`Directory does not exist: ${source.path}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ProjectModel
// ---------------------------------------------------------------------------

export class ProjectModel {
  readonly projectDir: string;
  readonly baseBranch: string;
  /** The git of `source`'s checkout, run on its node. With that node unreachable every command rejects
   * (an `RpcFailure` with code `"unavailable"`, which the router answers 503). */
  readonly git: Git;

  /** `source` is the checkout this call works in (`resolveSource`); the project's git and file
   * operations read it. */
  constructor(
    readonly projectId: number,
    private broadcast: Broadcast,
    private nodes: Pick<NodeHub, "get">,
    readonly source: Source,
  ) {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (source.project_id !== projectId) throw new SourceNotFoundError();
    this.projectDir = project.path;
    this.baseBranch = project.base_branch;
    this.git = sourceGit(nodes, source);
  }

  /**
   * Git workspace operations scoped to this project's checkout.
   */
  get workspace(): Workspace {
    const { id: sourceId, node_id: nodeId, path: cwd } = this.source;
    const node = this.nodes.get(nodeId);
    const read: ReadFile = async (path, { maxBytes } = {}) => {
      const input = { sourceId, cwd, path, ...(maxBytes ? { maxBytes } : {}) };
      const { result: { size }, body } = await node.openStream("fs.read", input, { timeoutMs: FS_REQUEST_TIMEOUT_MS });
      return { size, body };
    };
    return new Workspace(cwd, this.baseBranch, this.git, read);
  }

  /**
   * Return a ProjectTasks instance for task lifecycle operations.
   */
  tasks(): ProjectTasks {
    return new ProjectTasks(
      this.projectId,
      this.git,
      this.baseBranch,
      this.broadcast,
    );
  }

  /** Project-scoped code-review operations shared by HTTP and agent callers. */
  codeReviews(): ProjectCodeReviews {
    return new ProjectCodeReviews(this.projectId, this.broadcast);
  }

  /**
   * Fetch from origin, fast-forward the base branch, and reconcile
   * task statuses. This is a project-level "sync with remote" operation.
   */
  async sync(): Promise<void> {
    await this.git.fetchAll();
    await this.git.fastForwardBaseBranch(this.baseBranch);
    await this.reconcileClosedTasks();
  }

  // ---- File listing (the source's checkout, through its node) ---------------

  /**
   * List all non-ignored files in the project.
   * Combines tracked and untracked-but-not-ignored files into a
   * sorted, deduplicated list of relative paths.
   */
  async listFiles(): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      this.git.listTrackedFiles(),
      this.git.listUntrackedFiles(),
    ]);
    return [...new Set([...tracked, ...untracked])].toSorted();
  }

  /**
   * Read one level of a directory, returning typed entries sorted
   * with directories first, then files, alphabetical within each group.
   */
  async listDirectory(subPath = "."): Promise<DirectoryEntry[]> {
    const { id: sourceId, node_id: nodeId, path: cwd } = this.source;
    try {
      const { entries } = await this.nodes.get(nodeId).request(
        "fs.list",
        { sourceId, cwd, path: subPath },
        { timeoutMs: FS_REQUEST_TIMEOUT_MS },
      );
      return entries;
    } catch (error) {
      // The node's refusals, in the file browser's terms.
      const refusal = nodeRefusal(error);
      if (refusal?.code === "invalid_request") throw new PathTraversalError(refusal.message);
      if (refusal?.code === "not_found") throw new FileNotFoundError(refusal.message);
      throw error;
    }
  }

  // ---- Path safety ----------------------------------------------------------

  /**
   * Assert that a resolved path stays within the project directory.
   * Throws `PathTraversalError` if the path escapes.
   */
  private assertInsideProject(resolved: string): void {
    const normalizedProject = normalize(this.projectDir);
    if (!resolved.startsWith(normalizedProject + "/") && resolved !== normalizedProject) {
      throw new PathTraversalError();
    }
  }

  // ---- File uploads --------------------------------------------------------

  /**
   * Write one or more files into the project directory.
   *
   * Each file's name is sanitized to its basename to prevent directory
   * traversal. An optional `subPath` places files in a subdirectory
   * (intermediate directories are created automatically).
   *
   * Throws `NoFilesError` if the array is empty, `InvalidFilenameError`
   * for degenerate names, and `PathTraversalError` if the resolved
   * destination escapes the project.
   *
   * Returns the list of relative paths (from the project root) that
   * were written.
   */
  async writeFiles(
    files: { name: string; data: Blob | File }[],
    subPath = "",
  ): Promise<{ uploaded: string[] }> {
    if (files.length === 0) throw new NoFilesError();

    if (subPath) {
      this.assertInsideProject(resolve(this.projectDir, subPath));
    }

    const uploaded: string[] = [];

    for (const file of files) {
      const safeName = basename(file.name);
      if (!safeName || safeName === "." || safeName === "..") {
        throw new InvalidFilenameError(`Invalid filename: ${file.name}`);
      }

      const destDir = subPath
        ? resolve(this.projectDir, subPath)
        : this.projectDir;
      const destPath = resolve(destDir, safeName);
      this.assertInsideProject(destPath);

      mkdirSync(destDir, { recursive: true });
      await Bun.write(destPath, file.data);

      uploaded.push(subPath ? join(subPath, safeName) : safeName);
    }

    return { uploaded };
  }

  /**
   * Check which open tasks should be closed and update their status.
   * Called after fetch + fast-forward so local refs are current.
   *
   * A task is closed when:
   *  1. Its branch is reachable from the base branch (i.e. merged but not yet
   *     deleted), OR
   *  2. Its branch no longer exists locally or on the remote — this covers
   *     fast-forward merges where the branch was deleted before reconciliation
   *     ran, so `git branch --merged` can no longer see it.
   */
  private async reconcileClosedTasks(): Promise<void> {
    const openTasks = listOpenTasks(this.projectId);
    if (openTasks.length === 0) return;

    // 1. Branches that are still around and fully merged
    const mergedBranches = new Set(await this.git.getMergedBranches(this.baseBranch));

    const toClose: typeof openTasks = [];
    const toCleanUpBranch: typeof openTasks = [];

    for (const task of openTasks) {
      if (mergedBranches.has(task.branch_name)) {
        // The branch is reachable from the base branch. Only treat it as merged
        // if it actually diverged from its creation point — a branch created
        // from the base with zero commits is technically "merged" per git, but
        // the task hasn't started yet.
        //
        // Compare the branch tip to the stored base_commit SHA: if they're equal
        // the branch never received any commits and should be left open. If
        // base_commit is null (pre-migration task), fall through to close —
        // there's no way to distinguish, and closing is the safer default.
        if (task.base_commit) {
          const tip = await this.git.getBranchTip(task.branch_name);
          if (tip === task.base_commit) {
            // Branch never diverged — skip it
            continue;
          }
        }
        toClose.push(task);
        toCleanUpBranch.push(task);
      } else {
        // 2. Branch gone everywhere — treat as closed
        const local = await this.git.branchExists(task.branch_name);
        const remote = await this.git.remoteBranchExists(task.branch_name);
        if (!local && !remote) {
          toClose.push(task);
        }
      }
    }

    if (toClose.length === 0) return;

    const closedTaskIds = toClose.map((t) => t.id);
    markTasksClosed(closedTaskIds);
    const clearedFinishedSessionIds = clearFinishedActivityForTasks(closedTaskIds);
    this.broadcast({ type: "task_updated", projectId: this.projectId });
    for (const sessionId of clearedFinishedSessionIds) {
      this.broadcast({
        type: "session_updated",
        sessionId,
        projectId: this.projectId,
      });
    }

    // Clean up local branches for tasks that were detected via --merged
    const currentBranch = await this.git.getCurrentBranch();
    for (const task of toCleanUpBranch) {
      try {
        if (currentBranch === task.branch_name) {
          await this.git.checkoutBranch(this.baseBranch);
        }
        await this.git.deleteBranch(task.branch_name);
      } catch (err: any) {
        logger.warn(`  Could not delete branch ${task.branch_name}: ${err.message}`);
      }
    }
  }
}
