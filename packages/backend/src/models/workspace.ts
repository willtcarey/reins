import type { Git } from "../git.js";
import { isNodeUnavailable } from "../errors.js";
import { DiffParser, type DiffFileSummary } from "./diff-parser.js";
import type { FileSystem, ReadFile, WorkspaceFile } from "./file-system.js";
import { GitTreeFileSystem } from "./git-tree-file-system.js";
import { WorkingTreeFileSystem } from "./working-tree-file-system.js";

export type DiffMode = "branch" | "uncommitted";

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
    branch?: string,
  ): Promise<DiffFileSummary[]> {
    const { baseOrRange, untracked } = await this.diffScope(mode, branch);
    const raw = await this.git.getDiffNumstat(baseOrRange, { untracked }).catch((error: unknown) => {
      if (isNodeUnavailable(error)) throw error;
      return "";
    });
    return DiffParser.parseNumstat(raw);
  }

  /** Raw unified diff stream. */
  async *getDiffPatchStream(
    contextLines = 3,
    mode: DiffMode = "branch",
    branch?: string,
  ): AsyncGenerator<Uint8Array> {
    const { baseOrRange, untracked } = await this.diffScope(mode, branch);
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
    branch?: string,
  ): Promise<{ baseOrRange: string; untracked: boolean }> {
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
