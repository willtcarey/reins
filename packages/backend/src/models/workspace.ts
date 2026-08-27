import { constants, existsSync } from "node:fs";
import { access, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  trackFile,
  getCurrentBranch,
  getDiffNumstat,
  getGitBlobInfo,
  getGitPath,
  listUntrackedFiles,
  mergeBase,
  readGitBlobPrefix,
  streamDiffPatch,
  streamGitBlob,
} from "../git.js";
import { asyncIterableToText } from "../async-iterable.js";
import { detectMimeTypeFromBytes, detectMimeTypeFromFile } from "../mime.js";
import { DiffParser, type DiffFile, type DiffFileSummary } from "./diff-parser.js";

export type DiffMode = "branch" | "uncommitted";

export class InvalidWorkspacePathError extends Error {}
export class WorkspaceFileNotFoundError extends Error {}

export interface WorkspaceFile {
  filename: string;
  mimeType: string;
  size: number;
  openBody: () => Blob | ReadableStream<Uint8Array>;
}

async function noopCleanup() {}

/**
 * Build a temporary Git index that mirrors the real index, then mark untracked
 * files as intent-to-add so Git can produce native numstat and unified patches
 * without mutating the repository's real index.
 */
async function createTempDiffIndex(projectDir: string) {
  const untracked = await listUntrackedFiles(projectDir).catch(() => []);
  if (untracked.length === 0) return undefined;

  const tempDir = await mkdtemp(join(tmpdir(), "reins-git-index-"));
  const tempIndex = join(tempDir, "index");
  const cleanup = () => rm(tempDir, { recursive: true, force: true });

  try {
    const gitIndexPath = await getGitPath(projectDir, "index");
    const realIndex = isAbsolute(gitIndexPath) ? gitIndexPath : join(projectDir, gitIndexPath);
    if (existsSync(realIndex)) await copyFile(realIndex, tempIndex);

    const env: Record<string, string | undefined> = { GIT_INDEX_FILE: tempIndex };
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
      await trackFile(projectDir, file, env).catch(() => undefined);
    }

    return { env, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export class Workspace {
  constructor(
    readonly projectDir: string,
    readonly baseBranch = "main",
  ) {}

  /**
   * Open one file relative to this workspace root.
   *
   * With no ref, or when ref is the active branch, the working tree is used so
   * callers see uncommitted changes. Other refs are read from Git.
   */
  async openFile(filePath: string, ref?: string | null): Promise<WorkspaceFile> {
    const resolved = this.resolveFilePath(filePath);
    const readFromGit = ref && ref !== await getCurrentBranch(this.projectDir);
    if (readFromGit) return this.openGitFile(filePath, ref);

    let fileStats;
    try {
      fileStats = await stat(resolved);
    } catch {
      throw new WorkspaceFileNotFoundError();
    }
    if (!fileStats.isFile()) throw new WorkspaceFileNotFoundError();

    return {
      filename: basename(filePath) || filePath,
      mimeType: await detectMimeTypeFromFile(resolved),
      size: fileStats.size,
      openBody: () => Bun.file(resolved),
    };
  }

  /** Lightweight changed-file summaries using the diff endpoint branch/mode semantics. */
  async getChangedFiles(
    mode: DiffMode = "branch",
    branch?: string,
  ): Promise<DiffFileSummary[]> {
    const { baseOrRange, env, cleanup } = await this.prepareWorkspaceDiff(mode, branch);
    try {
      const raw = await getDiffNumstat(this.projectDir, baseOrRange, env).catch(() => "");
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
      yield* streamDiffPatch(this.projectDir, baseOrRange, contextLines, env);
    } finally {
      await cleanup().catch(() => undefined);
    }
  }

  /** Parsed diff hunks with raw text lines (highlighting is client-side). */
  async getDiff(
    contextLines = 3,
    mode: DiffMode = "branch",
    branch?: string,
  ): Promise<DiffFile[]> {
    const stream = this.getDiffPatchStream(contextLines, mode, branch);
    const raw = await asyncIterableToText(stream);
    return DiffParser.parsePatch(raw);
  }

  private resolveFilePath(filePath: string): string {
    const resolved = resolve(this.projectDir, filePath);
    const rel = relative(this.projectDir, resolved);
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      throw new InvalidWorkspacePathError("Path traversal not allowed");
    }
    return resolved;
  }

  private async openGitFile(filePath: string, ref: string): Promise<WorkspaceFile> {
    this.resolveFilePath(filePath);
    try {
      const { objectId, size } = await getGitBlobInfo(this.projectDir, ref, filePath);
      const prefix = await readGitBlobPrefix(this.projectDir, objectId);
      return {
        filename: basename(filePath) || filePath,
        mimeType: await detectMimeTypeFromBytes(prefix),
        size,
        openBody: () => streamGitBlob(this.projectDir, objectId),
      };
    } catch {
      throw new WorkspaceFileNotFoundError("File not found in ref");
    }
  }

  private async prepareWorkspaceDiff(
    mode: DiffMode,
    branch?: string,
  ) {
    const ref = branch ?? "HEAD";
    const requestedBranchActive = !branch || branch === await getCurrentBranch(this.projectDir);

    // The requested branch is not active, so only committed branch state is
    // visible from this checkout.
    if (!requestedBranchActive) {
      const baseOrRange = mode === "uncommitted" ? "HEAD..HEAD" : `${this.baseBranch}...${ref}`;
      return { baseOrRange, cleanup: noopCleanup };
    }

    const baseOrRange = mode === "uncommitted"
      ? "HEAD"
      : await mergeBase(this.projectDir, this.baseBranch, "HEAD")
          .then((sha) => sha || this.baseBranch)
          .catch(() => this.baseBranch);

    const tempIndex = await createTempDiffIndex(this.projectDir);
    return { baseOrRange, env: tempIndex?.env, cleanup: tempIndex?.cleanup ?? noopCleanup };
  }
}
