import { constants, existsSync } from "node:fs";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Git } from "../git.js";
import { DiffParser, type DiffFileSummary } from "./diff-parser.js";
import type { FileSystem, WorkspaceFile } from "./file-system.js";
import { GitTreeFileSystem } from "./git-tree-file-system.js";
import { WorkingTreeFileSystem } from "./working-tree-file-system.js";

export type DiffMode = "branch" | "uncommitted";

async function noopCleanup() {}

/**
 * Build a temporary Git index that mirrors the real index, then mark untracked
 * files as intent-to-add so Git can produce native numstat and unified patches
 * without mutating the repository's real index.
 */
async function createTempDiffIndex(projectDir: string, git: Git) {
  const untracked = await git.listUntrackedFiles().catch(() => []);
  if (untracked.length === 0) return undefined;

  const tempDir = await mkdtemp(join(tmpdir(), "reins-git-index-"));
  const tempIndex = join(tempDir, "index");
  const cleanup = () => rm(tempDir, { recursive: true, force: true });

  try {
    const gitIndexPath = await git.getGitPath("index");
    const realIndex = isAbsolute(gitIndexPath) ? gitIndexPath : join(projectDir, gitIndexPath);
    if (existsSync(realIndex)) await copyFile(realIndex, tempIndex);

    const env: Record<string, string> = { GIT_INDEX_FILE: tempIndex };
    for (const file of untracked) {
      // An unreadable intent-to-add file makes the later Git diff fail as a
      // whole, hiding every otherwise-readable change. Skip it up front.
      const readable = await access(join(projectDir, file), constants.R_OK)
        .then(() => true)
        .catch(() => false);
      if (!readable) continue;

      // Git cannot represent some untracked entries (for example nested repos
      // without a checked-out commit) as intent-to-add. Skip those rather than
      // falling back to synthetic patches; raw patches should stay Git-native.
      await git.trackFile(file, env).catch(() => undefined);
    }

    return { env, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export class Workspace {
  private readonly git: Git;

  constructor(
    readonly projectDir: string,
    readonly baseBranch = "main",
  ) {
    this.git = Git.local(projectDir);
  }

  /** Open a working-tree or committed Git file from this workspace. */
  async openFile(filePath: string, ref?: string | null): Promise<WorkspaceFile> {
    return (await this.fileSystemFor(ref)).openFile(filePath);
  }

  /** Lightweight changed-file summaries using the diff endpoint branch/mode semantics. */
  async getChangedFiles(
    mode: DiffMode = "branch",
    branch?: string,
  ): Promise<DiffFileSummary[]> {
    const { baseOrRange, env, cleanup } = await this.prepareWorkspaceDiff(mode, branch);
    try {
      const raw = await this.git.getDiffNumstat(baseOrRange, env).catch(() => "");
      return DiffParser.parseNumstat(raw);
    } finally {
      await cleanup();
    }
  }

  /** Raw unified diff stream. */
  async *getDiffPatchStream(
    contextLines = 3,
    mode: DiffMode = "branch",
    branch?: string,
  ): AsyncGenerator<Uint8Array> {
    const { baseOrRange, env, cleanup } = await this.prepareWorkspaceDiff(mode, branch);
    try {
      yield* this.git.streamDiffPatch(baseOrRange, contextLines, env);
    } finally {
      await cleanup().catch(() => undefined);
    }
  }

  private async fileSystemFor(ref?: string | null): Promise<FileSystem> {
    if (!ref || ref === await this.git.getCurrentBranch()) {
      return new WorkingTreeFileSystem(this.projectDir);
    }
    return new GitTreeFileSystem(this.projectDir, this.git, ref);
  }

  private async prepareWorkspaceDiff(
    mode: DiffMode,
    branch?: string,
  ) {
    const ref = branch ?? "HEAD";
    const requestedBranchActive = !branch || branch === await this.git.getCurrentBranch();

    // The requested branch is not active, so only committed branch state is
    // visible from this checkout.
    if (!requestedBranchActive) {
      const baseOrRange = mode === "uncommitted" ? "HEAD..HEAD" : `${this.baseBranch}...${ref}`;
      return { baseOrRange, cleanup: noopCleanup };
    }

    const baseOrRange = mode === "uncommitted"
      ? "HEAD"
      : await this.git.mergeBase(this.baseBranch, "HEAD")
          .then((sha) => sha || this.baseBranch)
          .catch(() => this.baseBranch);

    const tempIndex = await createTempDiffIndex(this.projectDir, this.git);
    return { baseOrRange, env: tempIndex?.env, cleanup: tempIndex?.cleanup ?? noopCleanup };
  }
}
