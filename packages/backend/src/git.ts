/**
 * Git Operations
 *
 * `Git` is one checkout's git: which commands to run and how to read their output. It runs each command
 * through the `Spawn` it is given, so the same operations work on a source's checkout through its node
 * (`RemoteNode.spawn`) and, until every caller has moved there, on the server's own (`Git.local`).
 */

import type { ProcessExit } from "@reins/node-protocol";
import { localSpawn, type Spawn } from "./spawn.js";

export interface Spread {
  aheadBase: number;
  behindBase: number;
  aheadRemote: number | null;
  behindRemote: number | null;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface GitBlobInfo {
  objectId: string;
  size: number;
}

// Reins consumes Git output as machine-readable data. Repository-configured
// drivers may require unavailable tools, expose transformed secrets, or emit
// output that cannot be parsed as a native patch.
const MACHINE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"] as const;

/** Parse newline-delimited git output into a list of non-empty strings. */
function parseLines(output: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

function failure(args: string[], exit: ProcessExit): Error {
  return new Error(`git ${args[0]} failed (exit ${exit.code ?? exit.signal}): ${exit.stderr.trim()}`);
}

export class Git {
  constructor(private readonly spawn: Spawn) {}

  /** The git of a checkout on this machine. Transitional, as `localSpawn` is. */
  static local(dir: string): Git {
    return new Git(localSpawn(dir));
  }

  /** `git <args>`: resolves with its stdout; a non-zero exit rejects with git's stderr. */
  private async run(args: string[], env?: Record<string, string>): Promise<string> {
    const proc = await this.spawn(["git", ...args], { env });
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exit.code !== 0) throw failure(args, exit);
    return stdout;
  }

  /** Whether `git <args>` exits 0. */
  private async succeeds(args: string[]): Promise<boolean> {
    const proc = await this.spawn(["git", ...args]);
    await new Response(proc.stdout).arrayBuffer();
    return (await proc.exited).code === 0;
  }

  /** `git <args>`'s stdout as it arrives; a non-zero exit fails the stream with git's stderr. */
  private async *stream(args: string[], env?: Record<string, string>): AsyncGenerator<Uint8Array> {
    const proc = await this.spawn(["git", ...args], { env });
    const reader = proc.stdout.getReader();
    let stdoutDone = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        yield next.value;
      }
      stdoutDone = true;
      const exit = await proc.exited;
      if (exit.code !== 0) throw failure(args, exit);
    } finally {
      if (!stdoutDone) await reader.cancel().catch(() => undefined);
    }
  }

  /** Resolve a path inside Git's metadata area, respecting worktree git files. */
  async getGitPath(pathName: string): Promise<string> {
    return (await this.run(["rev-parse", "--git-path", pathName])).trim();
  }

  /**
   * Detect the default branch for a repo (checks for main, master, develop).
   * Returns "main" if nothing is found.
   */
  async detectDefaultBranch(): Promise<string> {
    const candidates = ["main", "master", "develop"];
    const branches = await this.run(["branch", "--list", ...candidates]).catch(() => "");
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
  async fetchOrigin(branch: string): Promise<boolean> {
    try {
      await this.run(["fetch", "origin", branch]);
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
  async pullBaseBranch(baseBranch: string): Promise<void> {
    const fetched = await this.fetchOrigin(baseBranch);
    if (!fetched) return;
    await this.fastForwardBaseBranch(baseBranch);
  }

  /**
   * Fast-forward the local base branch ref to match origin/<baseBranch>
   * without checking it out. Assumes remote refs are already up to date
   * (i.e. a fetch has already been done). Silently skips if the
   * fast-forward fails (e.g. the local branch has diverged).
   */
  async fastForwardBaseBranch(baseBranch: string): Promise<void> {
    await this.run(["fetch", ".", `origin/${baseBranch}:${baseBranch}`]).catch(() => undefined);
  }

  /**
   * Create a branch from the base branch without checking it out.
   * Pulls the local base branch to match origin first so the new branch
   * (and subsequent diffs against the local base) start from the latest
   * upstream commit. Falls back gracefully for repos without a remote or
   * when the local branch has diverged.
   * Throws if the branch already exists.
   */
  async createBranch(branchName: string, baseBranch: string): Promise<void> {
    await this.pullBaseBranch(baseBranch);
    await this.run(["branch", branchName, baseBranch]);
  }

  /**
   * Check whether a local branch exists.
   */
  async branchExists(branchName: string): Promise<boolean> {
    return this.succeeds(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  }

  /**
   * Check whether a remote tracking branch exists (i.e. origin/<branchName>).
   */
  async remoteBranchExists(branchName: string): Promise<boolean> {
    return this.succeeds(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`]);
  }

  /**
   * Get the current branch name (HEAD).
   */
  async getCurrentBranch(): Promise<string> {
    const result = await this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    return result.trim() || "HEAD";
  }

  /**
   * Check out a branch.
   */
  async checkoutBranch(branchName: string): Promise<void> {
    await this.run(["checkout", branchName]);
  }

  /**
   * Delete a local branch. Uses -D (force) so it works even if unmerged.
   * Throws if the branch is currently checked out.
   */
  async deleteBranch(branchName: string): Promise<void> {
    await this.run(["branch", "-D", branchName]);
  }

  // ---- Remote sync operations ------------------------------------------------

  /**
   * Fetch all remote refs from origin.
   * Returns true if the fetch succeeded, false if there's no remote.
   */
  async fetchAll(): Promise<boolean> {
    try {
      await this.run(["fetch", "origin"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return commit counts for a branch relative to its base and remote tracking branch.
   * Uses local refs only — always instant. Remote fields are null if no remote tracking
   * branch exists.
   */
  async getSpread(branch: string, baseBranch: string): Promise<Spread> {
    const count = (range: string) => this.run(["rev-list", "--count", range]).then((s) => parseInt(s.trim(), 10) || 0);
    const [aheadBase, behindBase, aheadRemote, behindRemote] = await Promise.all([
      count(`${baseBranch}..${branch}`),
      count(`${branch}..${baseBranch}`),
      count(`origin/${branch}..${branch}`).catch(() => null),
      count(`${branch}..origin/${branch}`).catch(() => null),
    ]);

    return { aheadBase, behindBase, aheadRemote, behindRemote };
  }

  /** Return raw numstat output for a diff against a base or range expression. */
  async getDiffNumstat(baseOrRange: string, env?: Record<string, string>): Promise<string> {
    return await this.run(["diff", ...MACHINE_DIFF_FLAGS, "--numstat", baseOrRange], env);
  }

  /** Stream raw unified diff output for a diff against a base or range expression. */
  streamDiffPatch(baseOrRange: string, contextLines = 3, env?: Record<string, string>): AsyncGenerator<Uint8Array> {
    return this.stream(["diff", ...MACHINE_DIFF_FLAGS, `-U${contextLines}`, baseOrRange], env);
  }

  /**
   * Return total line additions/removals for a branch vs its base branch.
   * Uses `git diff --numstat baseBranch...branch` — local only, cheap.
   */
  async getDiffStats(branch: string, baseBranch: string): Promise<DiffStats> {
    const raw = await this.run(["diff", "--numstat", `${baseBranch}...${branch}`])
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
  async pushBranch(branch: string): Promise<void> {
    await this.run(["push", "origin", branch]);
  }

  /**
   * Rebase a branch onto the base branch.
   * On conflict, aborts and throws. (Agentic conflict resolution is handled at a higher layer.)
   * Restores the previously checked-out branch after the rebase completes.
   */
  async rebaseBranch(branch: string, baseBranch: string): Promise<void> {
    const previousBranch = await this.getCurrentBranch();
    const needsRestore = previousBranch !== branch;

    // Ensure we're on the target branch
    await this.run(["checkout", branch]);
    try {
      await this.run(["rebase", baseBranch]);
    } catch (err) {
      // Abort the in-progress rebase so the repo isn't left in a broken state
      await this.run(["rebase", "--abort"]);
      if (needsRestore) {
        await this.run(["checkout", previousBranch]).catch(() => {});
      }
      throw err;
    }

    // Restore the previously checked-out branch
    if (needsRestore) {
      await this.run(["checkout", previousBranch]).catch(() => {});
    }
  }

  /**
   * List local branches whose tips are reachable from the given base branch.
   * Returns branch names (without leading whitespace or `*` marker).
   */
  async getMergedBranches(baseBranch: string): Promise<string[]> {
    // Use -a to include remote tracking branches so we detect merges even when
    // the local branch has already been deleted (e.g. merged via PR or CLI).
    const raw = await this.run(["branch", "-a", "--merged", baseBranch]);
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
  async getBranchTip(branch: string): Promise<string | null> {
    // Try local first, then remote tracking ref
    const ref = (await this.branchExists(branch))
      ? branch
      : (await this.remoteBranchExists(branch))
        ? `origin/${branch}`
        : null;
    if (!ref) return null;
    const sha = await this.run(["rev-parse", ref]);
    return sha.trim() || null;
  }

  /**
   * Get the commit SHA at the tip of a ref (branch name, HEAD, etc.).
   * Does not check existence — use for refs known to exist (e.g. base branch).
   */
  async revParse(ref: string): Promise<string> {
    const sha = await this.run(["rev-parse", ref]);
    return sha.trim();
  }

  // ---- Merge base ------------------------------------------------------------

  /**
   * Return the best common ancestor (merge-base) of two refs.
   */
  async mergeBase(ref1: string, ref2: string): Promise<string> {
    const sha = await this.run(["merge-base", ref1, ref2]);
    return sha.trim();
  }

  // ---- Tracking branches -----------------------------------------------------

  /**
   * Create a local branch that tracks `origin/<branchName>`.
   */
  async trackBranch(branchName: string): Promise<void> {
    await this.run([
      "branch",
      "--track",
      branchName,
      `origin/${branchName}`,
    ]);
  }

  // ---- Blobs -----------------------------------------------------------------

  /** Resolve a file at a git ref to a blob object and size without reading it. */
  async getGitBlobInfo(ref: string, filePath: string): Promise<GitBlobInfo> {
    const objectId = (await this.run(["rev-parse", "--verify", `${ref}:${filePath}`])).trim();
    const type = (await this.run(["cat-file", "-t", objectId])).trim();
    if (type !== "blob") {
      throw new Error(`Not a file blob: ${ref}:${filePath}`);
    }

    const sizeText = (await this.run(["cat-file", "-s", objectId])).trim();
    return { objectId, size: Number.parseInt(sizeText, 10) || 0 };
  }

  /** Read only the leading bytes from a git blob for MIME sniffing. */
  async readGitBlobPrefix(objectId: string, maxBytes = 8192): Promise<Uint8Array> {
    const proc = await this.spawn(["git", "cat-file", "blob", objectId], { binary: true });
    const reader = proc.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (total < maxBytes) {
        const next = await reader.read();
        if (next.done) break;

        const bytes = next.value;
        const take = Math.min(bytes.byteLength, maxBytes - total);
        chunks.push(bytes.slice(0, take));
        total += take;

        if (take < bytes.byteLength) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
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
  streamGitBlob(objectId: string): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      start: async () => {
        reader = (await this.spawn(["git", "cat-file", "blob", objectId], { binary: true })).stdout.getReader();
      },
      async pull(controller) {
        const next = await reader!.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await reader?.cancel().catch(() => undefined);
      },
    });
  }

  // ---- File index/listing commands ---------------------------------------------

  /**
   * List tracked files (`git ls-files`).
   * Returns relative paths for all files in the index.
   */
  async listTrackedFiles(): Promise<string[]> {
    return parseLines(await this.run(["ls-files"]));
  }

  /**
   * List untracked files that are not ignored
   * (`git ls-files --others --exclude-standard`).
   * Returns relative paths for files on disk but not in the index.
   */
  async listUntrackedFiles(): Promise<string[]> {
    return parseLines(await this.run(["ls-files", "--others", "--exclude-standard"]));
  }

  /**
   * Mark a file with Git's intent-to-add bit (`git add -N`) in the active index.
   * Pass `GIT_INDEX_FILE` via env to target a temporary index.
   */
  async trackFile(filePath: string, env?: Record<string, string>): Promise<void> {
    await this.run(["add", "-N", "--", filePath], env);
  }
}
