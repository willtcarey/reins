/**
 * Project Model
 *
 * Business logic for project lifecycle: creation, remote sync, and file
 * content reading. Orchestrates store calls, git operations, and
 * WebSocket broadcasts.
 *
 * `createProject()` remains a standalone function (pre-project context).
 * For project-scoped operations, construct a `ProjectModel` instance.
 */

import { resolve, normalize, basename } from "path";
import {
  createProject as storeCreateProject,
  type Project,
} from "../project-store.js";
import { listOpenTasks, markTasksClosed } from "../task-store.js";
import {
  detectDefaultBranch,
  fetchAll,
  fastForwardBaseBranch,
  getMergedBranches,
  getBranchTip,
  branchExists,
  remoteBranchExists,
  getCurrentBranch,
  checkoutBranch,
  deleteBranch,
  showFile,
  showFileBinary,
} from "../git.js";
import type { Broadcast } from "./broadcast.js";
import type { ManagedSession } from "../state.js";
import { ProjectTasks } from "./tasks.js";

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

// ---------------------------------------------------------------------------
// Serve-file result
// ---------------------------------------------------------------------------

export interface ServeFileResult {
  /** File content — string for text mode, Uint8Array for binary/download */
  content: string | Uint8Array;
  /** Detected MIME type (e.g. "text/plain; charset=utf-8") */
  mimeType: string;
  /** Bare filename extracted from the path (e.g. "report.xlsx") */
  filename: string;
}

// ---------------------------------------------------------------------------
// Create project (standalone — no project context needed)
// ---------------------------------------------------------------------------

export interface CreateProjectParams {
  name: string;
  path: string;
  base_branch?: string;
}

/**
 * Create a project: detect the default branch (if not provided),
 * insert into the store, and translate UNIQUE constraint errors to a
 * descriptive error.
 *
 * Throws on failure — callers map to HTTP responses.
 */
export async function createProject(params: CreateProjectParams): Promise<Project> {
  const baseBranch = params.base_branch || await detectDefaultBranch(params.path);

  try {
    return storeCreateProject(params.name, params.path, baseBranch);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      throw new DuplicateProjectError();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ProjectModel
// ---------------------------------------------------------------------------

export class ProjectModel {
  constructor(
    readonly projectId: number,
    readonly projectDir: string,
    readonly baseBranch: string,
    private sessions: Map<string, ManagedSession>,
    private broadcast: Broadcast,
  ) {}

  /**
   * Return a ProjectTasks instance for task lifecycle operations.
   */
  tasks(): ProjectTasks {
    return new ProjectTasks(this.projectId, this.projectDir, this.baseBranch, this.sessions, this.broadcast);
  }

  /**
   * Fetch from origin, fast-forward the base branch, and reconcile
   * task statuses. This is a project-level "sync with remote" operation.
   */
  async sync(): Promise<void> {
    await fetchAll(this.projectDir);
    await fastForwardBaseBranch(this.projectDir, this.baseBranch);
    await this.reconcileClosedTasks();
  }

  /**
   * Read a file's content, either from a git ref or the working tree.
   *
   * When `ref` is provided and doesn't match the currently checked-out
   * branch, the content is read from that git ref via `git show`.
   * Otherwise the working tree is used so uncommitted edits are visible.
   *
   * Validates that the path doesn't escape the project directory.
   *
   * Throws `PathTraversalError` for path traversal, `FileNotFoundError`
   * when the file doesn't exist.
   */
  async readFile(filePath: string, ref?: string | null): Promise<string>;
  async readFile(filePath: string, ref: string | null | undefined, binary: true): Promise<Uint8Array>;
  async readFile(filePath: string, ref?: string | null, binary?: boolean): Promise<string | Uint8Array> {
    // Prevent path traversal
    const resolved = resolve(this.projectDir, filePath);
    const normalizedProject = normalize(this.projectDir);
    if (!resolved.startsWith(normalizedProject + "/") && resolved !== normalizedProject) {
      throw new PathTraversalError();
    }

    // Decide whether to read from git or the working tree.
    // If a ref is given but it matches the currently checked-out branch,
    // prefer the working tree so that uncommitted changes are visible.
    let useGit = false;
    if (ref) {
      const currentBranch = await getCurrentBranch(this.projectDir);
      useGit = currentBranch !== ref;
    }

    if (useGit) {
      try {
        return binary
          ? await showFileBinary(this.projectDir, ref!, filePath)
          : await showFile(this.projectDir, ref!, filePath);
      } catch {
        throw new FileNotFoundError("File not found in ref");
      }
    }

    // Read from working tree
    try {
      const file = Bun.file(resolved);
      return binary ? new Uint8Array(await file.arrayBuffer()) : await file.text();
    } catch {
      throw new FileNotFoundError();
    }
  }

  /**
   * Serve a file with MIME type detection and filename extraction.
   *
   * When `download` is true the content is returned as binary bytes;
   * otherwise it's returned as a UTF-8 string (suitable for rendering).
   *
   * The caller (route handler) uses the returned metadata to build
   * Content-Type and Content-Disposition headers.
   */
  async serveFile(
    filePath: string,
    ref?: string | null,
    download?: boolean,
  ): Promise<ServeFileResult> {
    const mimeType = Bun.file(filePath).type || "text/plain; charset=utf-8";
    const filename = basename(filePath) || filePath;

    const content = download
      ? await this.readFile(filePath, ref, true)
      : await this.readFile(filePath, ref);

    return { content, mimeType, filename };
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
    const mergedBranches = new Set(await getMergedBranches(this.projectDir, this.baseBranch));

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
          const tip = await getBranchTip(this.projectDir, task.branch_name);
          if (tip === task.base_commit) {
            // Branch never diverged — skip it
            continue;
          }
        }
        toClose.push(task);
        toCleanUpBranch.push(task);
      } else {
        // 2. Branch gone everywhere — treat as closed
        const local = await branchExists(this.projectDir, task.branch_name);
        const remote = await remoteBranchExists(this.projectDir, task.branch_name);
        if (!local && !remote) {
          toClose.push(task);
        }
      }
    }

    if (toClose.length === 0) return;

    markTasksClosed(toClose.map((t) => t.id));
    this.broadcast({ type: "task_updated", projectId: this.projectId });

    // Clean up local branches for tasks that were detected via --merged
    const currentBranch = await getCurrentBranch(this.projectDir);
    for (const task of toCleanUpBranch) {
      try {
        if (currentBranch === task.branch_name) {
          await checkoutBranch(this.projectDir, this.baseBranch);
        }
        await deleteBranch(this.projectDir, task.branch_name);
      } catch (err: any) {
        console.warn(`  Could not delete branch ${task.branch_name}: ${err.message}`);
      }
    }
  }
}
