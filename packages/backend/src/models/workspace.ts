import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  trackFile,
  getCurrentBranch,
  getDiffNumstat,
  getGitBlobInfo,
  GitFileNotFoundError,
  getGitPath,
  listUntrackedFiles,
  mergeBase,
  readGitBlobPrefix,
  streamDiffPatch,
  streamGitBlob,
} from "../git.js";
import { asyncIterableToText } from "../async-iterable.js";
import { DiffParser, type DiffFile, type DiffFileSummary } from "./diff-parser.js";

export type DiffMode = "branch" | "uncommitted";

export const DIFF_CONTENTS_SIZE_LIMIT = 1_048_576;

export class InvalidDiffContentPathError extends Error {}

export interface DiffFileContent {
  name: string;
  contents: string;
  /** Stable identity of the exact UTF-8 bytes returned. */
  contentId: string;
  /** Git object identity when this side came from an immutable tree. */
  blobId?: string;
}

export type DiffFileContentsResult =
  | { status: "available"; oldFile?: DiffFileContent; newFile?: DiffFileContent }
  | { status: "unsupported"; reason: "binary" }
  | { status: "too_large"; limitBytes: number };

interface ContentSource {
  name: string;
  size: number;
  blobId?: string;
  readPrefix: () => Promise<Uint8Array>;
  read: () => Promise<Uint8Array>;
}

async function noopCleanup() {}

function resolveWorkspaceFile(projectDir: string, filePath: string): string {
  const resolved = resolve(projectDir, filePath);
  const rel = relative(projectDir, resolved);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new InvalidDiffContentPathError("File path must stay inside the project");
  }
  return resolved;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const result = new Uint8Array(expectedSize);
  let offset = 0;

  try {
    while (offset < expectedSize) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > expectedSize) {
        throw new Error("Content exceeded its declared size");
      }
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
    const trailing = await reader.read();
    if (!trailing.done) throw new Error("Content exceeded its declared size");
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return offset === expectedSize ? result : result.slice(0, offset);
}

function containsNullByte(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function contentId(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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
   * Complete bounded text for both sides of one diff item.
   *
   * The endpoint-facing result uses explicit non-error outcomes for content
   * that cannot be expanded, while repository/read failures still reject.
   */
  async getDiffFileContents(
    oldPath: string | undefined,
    newPath: string | undefined,
    mode: DiffMode = "branch",
    branch?: string,
  ): Promise<DiffFileContentsResult> {
    const currentBranch = await getCurrentBranch(this.projectDir);
    const requestedBranchActive = !branch || branch === currentBranch;
    const selectedRef = branch ?? "HEAD";

    let oldRef: string;
    let newRef: string | undefined;
    if (mode === "uncommitted") {
      // A non-active branch has no associated working tree. Match the diff
      // contract by exposing its committed state on both sides (there is no
      // uncommitted diff to expand).
      oldRef = requestedBranchActive ? "HEAD" : selectedRef;
      newRef = requestedBranchActive ? undefined : selectedRef;
    } else {
      const comparisonRef = requestedBranchActive ? "HEAD" : selectedRef;
      oldRef = await mergeBase(this.projectDir, this.baseBranch, comparisonRef);
      newRef = requestedBranchActive ? undefined : selectedRef;
    }

    const [oldSource, newSource] = await Promise.all([
      oldPath ? this.openGitContentSource(oldPath, oldRef) : undefined,
      newPath
        ? newRef
          ? this.openGitContentSource(newPath, newRef)
          : this.openWorktreeContentSource(newPath)
        : undefined,
    ]);
    const sources = [oldSource, newSource].filter((source) => source !== undefined);

    if (sources.some((source) => source.size > DIFF_CONTENTS_SIZE_LIMIT)) {
      return { status: "too_large", limitBytes: DIFF_CONTENTS_SIZE_LIMIT };
    }

    const prefixes = await Promise.all(sources.map((source) => source.readPrefix()));
    if (prefixes.some(containsNullByte)) {
      return { status: "unsupported", reason: "binary" };
    }

    const [oldFile, newFile] = await Promise.all([
      oldSource ? this.readContentSource(oldSource) : undefined,
      newSource ? this.readContentSource(newSource) : undefined,
    ]);
    return { status: "available", oldFile, newFile };
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

  private async openWorktreeContentSource(filePath: string): Promise<ContentSource | undefined> {
    const resolved = resolveWorkspaceFile(this.projectDir, filePath);
    let fileStats;
    try {
      fileStats = await lstat(resolved);
    } catch (err) {
      if (typeof err === "object" && err !== null && Reflect.get(err, "code") === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    if (!fileStats.isFile()) return undefined;

    const file = Bun.file(resolved);
    return {
      name: filePath,
      size: fileStats.size,
      readPrefix: async () => new Uint8Array(
        await file.slice(0, Math.min(fileStats.size, 8192)).arrayBuffer(),
      ),
      read: async () => {
        const bytes = new Uint8Array(await file.slice(0, fileStats.size + 1).arrayBuffer());
        if (bytes.byteLength > fileStats.size) throw new Error("File grew while it was being read");
        return bytes;
      },
    };
  }

  private async openGitContentSource(filePath: string, ref: string): Promise<ContentSource | undefined> {
    resolveWorkspaceFile(this.projectDir, filePath);
    let info;
    try {
      info = await getGitBlobInfo(this.projectDir, ref, filePath);
    } catch (err) {
      if (err instanceof GitFileNotFoundError) return undefined;
      throw err;
    }

    return {
      name: filePath,
      size: info.size,
      blobId: info.objectId,
      readPrefix: () => readGitBlobPrefix(this.projectDir, info.objectId),
      read: () => readBoundedStream(streamGitBlob(this.projectDir, info.objectId), info.size),
    };
  }

  private async readContentSource(source: ContentSource): Promise<DiffFileContent> {
    const bytes = await source.read();
    return {
      name: source.name,
      contents: new TextDecoder().decode(bytes),
      contentId: contentId(bytes),
      ...(source.blobId ? { blobId: source.blobId } : {}),
    };
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
