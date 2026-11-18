import type { Git } from "../git.js";
import { isNodeUnavailable } from "../errors.js";
import { DiffParser, type DiffFileSummary } from "./diff-parser.js";
import type { FileSystem, ReadFile, WorkspaceFile } from "./file-system.js";
import { GitTreeFileSystem } from "./git-tree-file-system.js";
import { WorkingTreeFileSystem } from "./working-tree-file-system.js";
import { timedSync } from "../request-timing.js";

export type DiffMode = "branch" | "uncommitted";

/** What a diff compares: a task's own `branch` (with the base branch), or the working tree since a `base`
 * commit (a task without a branch: what changed since it started). Neither: the checkout's HEAD against
 * the base branch. */
export interface DiffTarget { branch?: string; base?: string }

/** A task's diff: its branch's, else the working tree's since it started; none (HEAD's) before its first run. */
export function taskDiffTarget(task: { branch_name: string | null; base_commit: string | null } | null): DiffTarget {
  if (task?.branch_name) return { branch: task.branch_name };
  return task?.base_commit ? { base: task.base_commit } : {};
}

export class Workspace {
  constructor(
    /** The checkout's path (on its node). */
    readonly root: string,
    readonly baseBranch: string,
    /** The checkout's git (on its node). */
    private readonly git: Git,
    /** Reads the checkout's working-tree files (on its node). */
    private readonly read: ReadFile,
  ) {}

  /** Open a working-tree or committed Git file from this workspace. */
  async openFile(filePath: string, ref?: string | null): Promise<WorkspaceFile> {
    return (await this.fileSystemFor(ref)).openFile(filePath);
  }

  /** Lightweight changed-file summaries using the diff endpoint branch/mode semantics. A diff git
   * cannot produce (e.g. a missing base branch) has no changes; an unreachable node rejects. */
  async getChangedFiles(
    mode: DiffMode = "branch",
    target: DiffTarget = {},
  ): Promise<DiffFileSummary[]> {
    const { baseOrRange, untracked } = await this.diffScope(mode, target);
    const raw = await this.git.getDiffNumstat(baseOrRange, { untracked }).catch((error: unknown) => {
      if (isNodeUnavailable(error)) throw error;
      return "";
    });
    return timedSync("parse numstat", () => DiffParser.parseNumstat(raw));
  }

  /** The checkout's current branch; null when git cannot tell (a directory that is not a repository). An
   * unreachable node rejects. */
  async currentBranch(): Promise<string | null> {
    return this.git.getCurrentBranch().catch((error: unknown) => {
      if (isNodeUnavailable(error)) throw error;
      return null;
    });
  }

  /** Raw unified diff stream. */
  async *getDiffPatchStream(
    contextLines = 3,
    mode: DiffMode = "branch",
    target: DiffTarget = {},
  ): AsyncGenerator<Uint8Array> {
    const { baseOrRange, untracked } = await this.diffScope(mode, target);
    yield* this.git.streamDiffPatch(baseOrRange, contextLines, { untracked });
  }

  private async fileSystemFor(ref?: string | null): Promise<FileSystem> {
    if (!ref || ref === await this.git.getCurrentBranch()) {
      return new WorkingTreeFileSystem(this.root, this.read);
    }
    return new GitTreeFileSystem(this.root, this.git, ref);
  }

  /** What to diff: the base or range, and whether the working tree's untracked files count. */
  private async diffScope(
    mode: DiffMode,
    { branch, base }: DiffTarget,
  ): Promise<{ baseOrRange: string; untracked: boolean }> {
    if (!branch && base) return { baseOrRange: mode === "uncommitted" ? "HEAD" : base, untracked: true };
    const ref = branch ?? "HEAD";
    const requestedBranchActive = !branch || branch === await this.git.getCurrentBranch();

    // The requested branch is not active, so only committed branch state is
    // visible from this checkout.
    if (!requestedBranchActive) {
      const baseOrRange = mode === "uncommitted" ? "HEAD..HEAD" : `${this.baseBranch}...${ref}`;
      return { baseOrRange, untracked: false };
    }

    const baseOrRange = mode === "uncommitted"
      ? "HEAD"
      : await this.git.mergeBase(this.baseBranch, "HEAD")
          .then((sha) => sha || this.baseBranch)
          .catch((error: unknown) => {
            if (isNodeUnavailable(error)) throw error;
            return this.baseBranch;
          });

    return { baseOrRange, untracked: true };
  }
}
