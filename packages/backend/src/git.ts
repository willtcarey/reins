/**
 * Git Operations
 *
 * Utilities for retrieving git diffs and branch info from a project directory.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

function runGitStream(projectDir: string, args: string[], env?: Record<string, string | undefined>): AsyncGenerator<Uint8Array> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Keep stderr drained so the child cannot block on a full stderr pipe, and
  // retain it so stream consumers see git failures instead of silent EOF.
  const stderr = Bun.readableStreamToText(proc.stderr).catch(() => "");

  return (async function* gitStream() {
    let stdoutDone = false;

    try {
      for await (const chunk of proc.stdout) {
        yield chunk;
      }
      stdoutDone = true;

      const [exitCode, stderrText] = await Promise.all([proc.exited, stderr]);
      if (exitCode !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderrText.trim()}`);
      }
    } finally {
      if (!stdoutDone) {
        proc.kill();
        await proc.exited.catch(() => undefined);
        await stderr.catch(() => undefined);
      }
    }
  })();
}

async function runGit(projectDir: string, args: string[], env?: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/** Resolve a path inside Git's metadata area, respecting worktree git files. */
export async function getGitPath(projectDir: string, pathName: string): Promise<string> {
  return (await runGit(projectDir, ["rev-parse", "--git-path", pathName])).trim();
}

/**
 * Detect the default branch for a repo (checks for main, master, develop).
 * Returns "main" if nothing is found.
 */
export async function detectDefaultBranch(projectDir: string): Promise<string> {
  const candidates = ["main", "master", "develop"];
  const branches = await runGit(projectDir, ["branch", "--list", ...candidates]).catch(() => "");
  for (const candidate of candidates) {
    // `git branch --list` output has "  branch" or "* branch" format
    if (branches.split("\n").some((l) => l.trim().replace(/^\* /, "") === candidate)) {
      return candidate;
    }
  }
  return "main";
}

// ---- Branch operations -----------------------------------------------------

/**
 * Fetch the latest refs from origin for a given branch.
 * Returns true if the fetch succeeded, false if the remote doesn't exist.
 */
export async function fetchOrigin(
  projectDir: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(projectDir, ["fetch", "origin", branch]);
    return true;
  } catch {
    return false;
  }
}


/**
 * Fast-forward the local base branch to match origin without checking it out.
 * This keeps the local branch up to date so diffs against it are accurate.
 * Silently skips if there's no remote or the fast-forward fails (e.g. the
 * local branch has diverged).
 */
export async function pullBaseBranch(
  projectDir: string,
  baseBranch: string,
): Promise<void> {
  const fetched = await fetchOrigin(projectDir, baseBranch);
  if (!fetched) return;
  await fastForwardBaseBranch(projectDir, baseBranch);
}

/**
 * Fast-forward the local base branch ref to match origin/<baseBranch>
 * without checking it out. Assumes remote refs are already up to date
 * (i.e. a fetch has already been done). Silently skips if the
 * fast-forward fails (e.g. the local branch has diverged).
 */
export async function fastForwardBaseBranch(
  projectDir: string,
  baseBranch: string,
): Promise<void> {
  await runGit(projectDir, ["fetch", ".", `origin/${baseBranch}:${baseBranch}`]).catch(() => undefined);
}

/**
 * Create a branch from the base branch without checking it out.
 * Pulls the local base branch to match origin first so the new branch
 * (and subsequent diffs against the local base) start from the latest
 * upstream commit. Falls back gracefully for repos without a remote or
 * when the local branch has diverged.
 * Throws if the branch already exists.
 */
export async function createBranch(
  projectDir: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  await pullBaseBranch(projectDir, baseBranch);
  await runGit(projectDir, ["branch", branchName, baseBranch]);
}

/**
 * Check whether a local branch exists.
 */
export async function branchExists(
  projectDir: string,
  branchName: string,
): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Check whether a remote tracking branch exists (i.e. origin/<branchName>).
 */
export async function remoteBranchExists(
  projectDir: string,
  branchName: string,
): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Get the current branch name (HEAD).
 */
export async function getCurrentBranch(projectDir: string): Promise<string> {
  const result = await runGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.trim() || "HEAD";
}

/**
 * Check out a branch.
 */
export async function checkoutBranch(
  projectDir: string,
  branchName: string,
): Promise<void> {
  await runGit(projectDir, ["checkout", branchName]);
}

/**
 * Delete a local branch. Uses -D (force) so it works even if unmerged.
 * Throws if the branch is currently checked out.
 */
export async function deleteBranch(
  projectDir: string,
  branchName: string,
): Promise<void> {
  await runGit(projectDir, ["branch", "-D", branchName]);
}

// ---- Remote sync operations ------------------------------------------------

/**
 * Fetch all remote refs from origin.
 * Returns true if the fetch succeeded, false if there's no remote.
 */
export async function fetchAll(projectDir: string): Promise<boolean> {
  try {
    await runGit(projectDir, ["fetch", "origin"]);
    return true;
  } catch {
    return false;
  }
}

export interface Spread {
  aheadBase: number;
  behindBase: number;
  aheadRemote: number | null;
  behindRemote: number | null;
}

/**
 * Return commit counts for a branch relative to its base and remote tracking branch.
 * Uses local refs only — always instant. Remote fields are null if no remote tracking
 * branch exists.
 */
export async function getSpread(
  projectDir: string,
  branch: string,
  baseBranch: string,
): Promise<Spread> {
  const [aheadBase, behindBase, aheadRemote, behindRemote] = await Promise.all([
    runGit(projectDir, ["rev-list", "--count", `${baseBranch}..${branch}`])
      .then((s) => parseInt(s.trim(), 10) || 0),
    runGit(projectDir, ["rev-list", "--count", `${branch}..${baseBranch}`])
      .then((s) => parseInt(s.trim(), 10) || 0),
    runGit(projectDir, ["rev-list", "--count", `origin/${branch}..${branch}`])
      .then((s) => parseInt(s.trim(), 10) || 0)
      .catch(() => null),
    runGit(projectDir, ["rev-list", "--count", `${branch}..origin/${branch}`])
      .then((s) => parseInt(s.trim(), 10) || 0)
      .catch(() => null),
  ]);

  return { aheadBase, behindBase, aheadRemote, behindRemote };
}

export interface DiffStats {
  additions: number;
  removals: number;
}

/** Return raw numstat output for a diff against a base or range expression. */
export async function getDiffNumstat(
  projectDir: string,
  baseOrRange: string,
  env?: Record<string, string | undefined>,
): Promise<string> {
  return await runGit(projectDir, ["diff", "--numstat", baseOrRange], env);
}

/** Stream raw unified diff output for a diff against a base or range expression. */
export function streamDiffPatch(
  projectDir: string,
  baseOrRange: string,
  contextLines = 3,
  env?: Record<string, string | undefined>,
): AsyncGenerator<Uint8Array> {
  return runGitStream(projectDir, ["diff", `-U${contextLines}`, baseOrRange], env);
}

/**
 * Return total line additions/removals for a branch vs its base branch.
 * Uses `git diff --numstat baseBranch...branch` — local only, cheap.
 */
export async function getDiffStats(
  projectDir: string,
  branch: string,
  baseBranch: string,
): Promise<DiffStats> {
  const raw = await runGit(projectDir, ["diff", "--numstat", `${baseBranch}...${branch}`])
    .catch(() => "");
  let additions = 0;
  let removals = 0;
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const [add, rem] = line.split("\t");
    additions += add === "-" ? 0 : parseInt(add, 10) || 0;
    removals += rem === "-" ? 0 : parseInt(rem, 10) || 0;
  }
  return { additions, removals };
}

/**
 * Push a branch to origin. Throws on failure.
 */
export async function pushBranch(
  projectDir: string,
  branch: string,
): Promise<void> {
  await runGit(projectDir, ["push", "origin", branch]);
}

/**
 * Rebase a branch onto the base branch.
 * On conflict, aborts and throws. (Agentic conflict resolution is handled at a higher layer.)
 * Restores the previously checked-out branch after the rebase completes.
 */
export async function rebaseBranch(
  projectDir: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  const previousBranch = await getCurrentBranch(projectDir);
  const needsRestore = previousBranch !== branch;

  // Ensure we're on the target branch
  await runGit(projectDir, ["checkout", branch]);
  try {
    await runGit(projectDir, ["rebase", baseBranch]);
  } catch (err) {
    // Abort the in-progress rebase so the repo isn't left in a broken state
    await runGit(projectDir, ["rebase", "--abort"]);
    if (needsRestore) {
      await runGit(projectDir, ["checkout", previousBranch]).catch(() => {});
    }
    throw err;
  }

  // Restore the previously checked-out branch
  if (needsRestore) {
    await runGit(projectDir, ["checkout", previousBranch]).catch(() => {});
  }
}

/**
 * List local branches whose tips are reachable from the given base branch.
 * Returns branch names (without leading whitespace or `*` marker).
 */
export async function getMergedBranches(
  projectDir: string,
  baseBranch: string,
): Promise<string[]> {
  // Use -a to include remote tracking branches so we detect merges even when
  // the local branch has already been deleted (e.g. merged via PR or CLI).
  const raw = await runGit(projectDir, ["branch", "-a", "--merged", baseBranch]);
  const names = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim().replace(/^\* /, "");
    if (!trimmed) continue;
    // Remote tracking branches appear as "remotes/origin/foo" — normalise to "foo"
    const stripped = trimmed.replace(/^remotes\/origin\//, "");
    names.add(stripped);
  }
  return [...names];
}

/**
 * Get the commit SHA at the tip of a branch.
 * Checks local branch first; falls back to remote tracking ref.
 * Returns null if neither exists.
 */
export async function getBranchTip(
  projectDir: string,
  branch: string,
): Promise<string | null> {
  // Try local first, then remote tracking ref
  const ref = (await branchExists(projectDir, branch))
    ? branch
    : (await remoteBranchExists(projectDir, branch))
      ? `origin/${branch}`
      : null;
  if (!ref) return null;
  const sha = await runGit(projectDir, ["rev-parse", ref]);
  return sha.trim() || null;
}

/**
 * Get the commit SHA at the tip of a ref (branch name, HEAD, etc.).
 * Does not check existence — use for refs known to exist (e.g. base branch).
 */
export async function revParse(
  projectDir: string,
  ref: string,
): Promise<string> {
  const sha = await runGit(projectDir, ["rev-parse", ref]);
  return sha.trim();
}

// ---- Merge base ------------------------------------------------------------

/**
 * Return the best common ancestor (merge-base) of two refs.
 */
export async function mergeBase(
  projectDir: string,
  ref1: string,
  ref2: string,
): Promise<string> {
  const sha = await runGit(projectDir, ["merge-base", ref1, ref2]);
  return sha.trim();
}

// ---- Tracking branches -----------------------------------------------------

/**
 * Create a local branch that tracks `origin/<branchName>`.
 */
export async function trackBranch(
  projectDir: string,
  branchName: string,
): Promise<void> {
  await runGit(projectDir, [
    "branch",
    "--track",
    branchName,
    `origin/${branchName}`,
  ]);
}

// ---- File content from git ref ---------------------------------------------

/**
 * Read a file's content from a git ref (branch, tag, or commit SHA)
 * via `git show ref:path`. Throws if the file doesn't exist at that ref.
 */
export async function showFile(
  projectDir: string,
  ref: string,
  filePath: string,
): Promise<string> {
  return await runGit(projectDir, ["show", `${ref}:${filePath}`]);
}

/**
 * Read a file's binary content from a git ref via `git show ref:path`.
 * Returns raw bytes instead of a decoded string.
 */
export async function showFileBinary(
  projectDir: string,
  ref: string,
  filePath: string,
): Promise<Uint8Array> {
  const proc = Bun.spawn(["git", "show", `${ref}:${filePath}`], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git show failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return new Uint8Array(stdout);
}

export interface GitBlobInfo {
  objectId: string;
  size: number;
}

/** Resolve a file at a git ref to a blob object and size without reading it. */
export async function getGitBlobInfo(
  projectDir: string,
  ref: string,
  filePath: string,
): Promise<GitBlobInfo> {
  const objectId = (await runGit(projectDir, ["rev-parse", "--verify", `${ref}:${filePath}`])).trim();
  const type = (await runGit(projectDir, ["cat-file", "-t", objectId])).trim();
  if (type !== "blob") {
    throw new Error(`Not a file blob: ${ref}:${filePath}`);
  }

  const sizeText = (await runGit(projectDir, ["cat-file", "-s", objectId])).trim();
  return { objectId, size: Number.parseInt(sizeText, 10) || 0 };
}

/** Read only the leading bytes from a git blob for MIME sniffing. */
export async function readGitBlobPrefix(
  projectDir: string,
  objectId: string,
  maxBytes = 8192,
): Promise<Uint8Array> {
  const proc = Bun.spawn(["git", "cat-file", "blob", objectId], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  void new Response(proc.stderr).text().catch(() => undefined);

  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;

  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }

      const bytes = next.value;
      const take = Math.min(bytes.byteLength, maxBytes - total);
      chunks.push(bytes.slice(0, take));
      total += take;

      if (take < bytes.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    if (!done) proc.kill();
    await proc.exited.catch(() => undefined);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Stream a git blob without buffering the full content in memory. */
export function streamGitBlob(projectDir: string, objectId: string): ReadableStream<Uint8Array> {
  const proc = Bun.spawn(["git", "cat-file", "blob", objectId], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  void new Response(proc.stderr).text().catch(() => undefined);

  const reader = proc.stdout.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        await proc.exited.catch(() => undefined);
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      proc.kill();
      await proc.exited.catch(() => undefined);
    },
  });
}

// ---- Large / binary file detection -----------------------------------------

/** Default size threshold for skipping diffs (1 MB). */
const DEFAULT_SIZE_THRESHOLD = 1_048_576;

/**
 * Check whether a file is too large or binary to diff safely.
 *
 * Returns `true` when:
 * - The path is an un-diffable directory entry,
 * - The file size exceeds `threshold` bytes (default 1 MB), or
 * - The first 8 KB of the file contains a null byte (binary heuristic).
 *
 * Returns `"large" | "binary" | false` detail when needed internally,
 * but the public API returns a simple boolean.
 */
export async function isLargeOrBinary(
  projectDir: string,
  filePath: string,
  threshold = DEFAULT_SIZE_THRESHOLD,
): Promise<boolean> {
  const result = await classifyFile(projectDir, filePath, threshold);
  return result !== false;
}

/**
 * Internal: classify a file as "large", "binary", or false (normal text).
 */
type FileClassification = "large" | "binary" | "directory" | false;

async function classifyFile(
  projectDir: string,
  filePath: string,
  threshold = DEFAULT_SIZE_THRESHOLD,
): Promise<FileClassification> {
  const absolutePath = join(projectDir, filePath);
  const stats = await stat(absolutePath);
  if (stats.isDirectory()) return "directory";
  if (!stats.isFile()) return "binary";

  const file = Bun.file(absolutePath);
  const size = file.size;
  if (size > threshold) return "large";

  // Read first 8 KB to check for null bytes (binary heuristic)
  const chunk = await file.slice(0, 8192).arrayBuffer();
  const bytes = new Uint8Array(chunk);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return "binary";
  }
  return false;
}

// ---------------------------------------------------------------------------
// File index/listing commands
// ---------------------------------------------------------------------------

/** Parse newline-delimited git output into a list of non-empty strings. */
function parseLines(output: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

/**
 * List tracked files (`git ls-files`).
 * Returns relative paths for all files in the index.
 */
export async function listTrackedFiles(projectDir: string): Promise<string[]> {
  return parseLines(await runGit(projectDir, ["ls-files"]));
}

/**
 * List untracked files that are not ignored
 * (`git ls-files --others --exclude-standard`).
 * Returns relative paths for files on disk but not in the index.
 */
export async function listUntrackedFiles(projectDir: string): Promise<string[]> {
  return parseLines(await runGit(projectDir, ["ls-files", "--others", "--exclude-standard"]));
}

/**
 * Mark a file with Git's intent-to-add bit (`git add -N`) in the active index.
 * Pass `GIT_INDEX_FILE` via env to target a temporary index.
 */
export async function trackFile(
  projectDir: string,
  filePath: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  await runGit(projectDir, ["add", "-N", "--", filePath], env);
}
