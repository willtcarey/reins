/**
 * Git Operations
 *
 * Utilities for retrieving git diffs and branch info from a project directory.
 */

async function run(projectDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout;
}

/**
 * Like run(), but throws with stderr on non-zero exit.
 */
async function runChecked(projectDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Detect the default branch for a repo (checks for main, master, develop).
 * Returns "main" if nothing is found.
 */
export async function detectDefaultBranch(projectDir: string): Promise<string> {
  const candidates = ["main", "master", "develop"];
  const branches = await run(projectDir, ["branch", "--list", ...candidates]).catch(() => "");
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
    await runChecked(projectDir, ["fetch", "origin", branch]);
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
  await run(projectDir, ["fetch", ".", `origin/${baseBranch}:${baseBranch}`]);
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
  await runChecked(projectDir, ["branch", branchName, baseBranch]);
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
 * Check out a branch.
 */
export async function checkoutBranch(
  projectDir: string,
  branchName: string,
): Promise<void> {
  await runChecked(projectDir, ["checkout", branchName]);
}

/**
 * Delete a local branch. Uses -D (force) so it works even if unmerged.
 * Throws if the branch is currently checked out.
 */
export async function deleteBranch(
  projectDir: string,
  branchName: string,
): Promise<void> {
  await runChecked(projectDir, ["branch", "-D", branchName]);
}

/**
 * Get the current branch name (HEAD).
 */
export async function getCurrentBranch(projectDir: string): Promise<string> {
  const result = await run(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.trim() || "HEAD";
}

// ---- Remote sync operations ------------------------------------------------

/**
 * Fetch all remote refs from origin.
 * Returns true if the fetch succeeded, false if there's no remote.
 */
export async function fetchAll(projectDir: string): Promise<boolean> {
  try {
    await runChecked(projectDir, ["fetch", "origin"]);
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
    run(projectDir, ["rev-list", "--count", `${baseBranch}..${branch}`])
      .then((s) => parseInt(s.trim(), 10) || 0),
    run(projectDir, ["rev-list", "--count", `${branch}..${baseBranch}`])
      .then((s) => parseInt(s.trim(), 10) || 0),
    runChecked(projectDir, ["rev-list", "--count", `origin/${branch}..${branch}`])
      .then((s) => parseInt(s.trim(), 10) || 0)
      .catch(() => null),
    runChecked(projectDir, ["rev-list", "--count", `${branch}..origin/${branch}`])
      .then((s) => parseInt(s.trim(), 10) || 0)
      .catch(() => null),
  ]);

  return { aheadBase, behindBase, aheadRemote, behindRemote };
}

export interface DiffStats {
  additions: number;
  removals: number;
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
  const raw = await run(projectDir, ["diff", "--numstat", `${baseBranch}...${branch}`])
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
  await runChecked(projectDir, ["push", "origin", branch]);
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
  await runChecked(projectDir, ["checkout", branch]);
  try {
    await runChecked(projectDir, ["rebase", baseBranch]);
  } catch (err) {
    // Abort the in-progress rebase so the repo isn't left in a broken state
    await run(projectDir, ["rebase", "--abort"]);
    if (needsRestore) {
      await runChecked(projectDir, ["checkout", previousBranch]).catch(() => {});
    }
    throw err;
  }

  // Restore the previously checked-out branch
  if (needsRestore) {
    await runChecked(projectDir, ["checkout", previousBranch]).catch(() => {});
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
  const raw = await run(projectDir, ["branch", "-a", "--merged", baseBranch]);
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
  const sha = await run(projectDir, ["rev-parse", ref]);
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
  const sha = await runChecked(projectDir, ["rev-parse", ref]);
  return sha.trim();
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
  return await runChecked(projectDir, ["show", `${ref}:${filePath}`]);
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

// ---- Working-tree diff -----------------------------------------------------

/**
 * Is the working tree accessible for this branch?
 * True when `branch` is omitted (HEAD mode) or is the currently checked-out
 * branch. When false, we can only diff committed state — the working tree
 * belongs to a different branch.
 */
async function isWorkingTreeAvailable(
  projectDir: string,
  branch?: string,
): Promise<boolean> {
  if (!branch) return true;
  const head = await getCurrentBranch(projectDir);
  return branch === head;
}

/**
 * Build a raw unified-diff string for a single diff mode.
 *
 * - `"branch"` mode: all changes (committed + uncommitted) against the merge
 *   base. When the branch is checked out, diffs the working tree directly
 *   against the merge base so committed and uncommitted changes are captured
 *   in one pass with no overlap. When the branch is not checked out, falls
 *   back to `baseBranch...ref` (committed only — no working tree access).
 *
 * - `"uncommitted"` mode: only uncommitted changes relative to HEAD.
 *
 * Untracked files are included in both modes (when the branch is checked out)
 * by synthesising diffs via `git diff --no-index /dev/null <file>`.
 */
async function getGitDiff(
  projectDir: string,
  contextLines = 3,
  baseBranch = "main",
  mode: "branch" | "uncommitted" = "branch",
  branch?: string,
): Promise<string> {
  const ctxFlag = `-U${contextLines}`;
  const ref = branch ?? "HEAD";
  const hasWorkingTree = await isWorkingTreeAvailable(projectDir, branch);

  // Can't see uncommitted state for a branch that isn't checked out
  if (!hasWorkingTree) {
    if (mode === "uncommitted") return "";
    return await run(projectDir, ["diff", ctxFlag, `${baseBranch}...${ref}`]).catch(() => "");
  }

  // Working tree is available — choose the diff base by mode
  if (mode === "uncommitted") {
    // Uncommitted only: diff against HEAD
    const [tracked, untrackedList] = await Promise.all([
      run(projectDir, ["diff", ctxFlag, "HEAD"]).catch(() => ""),
      run(projectDir, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
    ]);
    const untracked = await diffUntrackedFiles(projectDir, ctxFlag, untrackedList);
    return [tracked, untracked].filter(Boolean).join("\n");
  }

  // Branch mode: diff working tree against merge base (captures committed +
  // uncommitted in one pass, no overlap)
  const [mergeBase, untrackedList] = await Promise.all([
    run(projectDir, ["merge-base", baseBranch, "HEAD"])
      .then((s) => s.trim()).catch(() => ""),
    run(projectDir, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);
  const diffBase = mergeBase || baseBranch;
  const tracked = await run(projectDir, ["diff", ctxFlag, diffBase]).catch(() => "");
  const untracked = await diffUntrackedFiles(projectDir, ctxFlag, untrackedList);
  return [tracked, untracked].filter(Boolean).join("\n");
}

/** Synthesise unified diffs for untracked files so they appear as new files. */
async function diffUntrackedFiles(
  projectDir: string,
  ctxFlag: string,
  untrackedList: string,
): Promise<string> {
  const files = untrackedList.trim().split("\n").filter(Boolean);
  if (files.length === 0) return "";
  const diffs = await Promise.all(
    files.map((file) =>
      run(projectDir, ["diff", ctxFlag, "--no-index", "--", "/dev/null", file])
        .catch(() => ""),
    ),
  );
  return diffs.filter(Boolean).join("\n");
}

// ---- Diff types ------------------------------------------------------------

export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  additions: number;
  removals: number;
  hunks: DiffHunk[];
}

// ---- Diff parser -----------------------------------------------------------

export interface ParsedHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: { prefix: "+" | "-" | " "; text: string }[];
}

export interface ParsedFile {
  path: string;
  hunks: ParsedHunk[];
}

export function parseUnifiedDiff(raw: string): ParsedFile[] {
  if (!raw?.trim()) return [];

  const files: ParsedFile[] = [];
  const lines = raw.split("\n");
  let currentFile: ParsedFile | null = null;
  let currentHunk: ParsedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.*?) b\/(.*)/);
      currentFile = { path: match ? match[2] : line, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (
      line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") ||
      line.startsWith("new file mode") || line.startsWith("deleted file mode") ||
      line.startsWith("old mode") || line.startsWith("new mode") ||
      line.startsWith("rename from") || line.startsWith("rename to") ||
      line.startsWith("similarity index") || line.startsWith("Binary files")
    ) continue;

    if (line.startsWith("@@")) {
      if (!currentFile) continue;
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentHunk = {
        header: line,
        oldStart: match ? parseInt(match[1], 10) : 0,
        newStart: match ? parseInt(match[2], 10) : 0,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ prefix: "+", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ prefix: "-", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ prefix: " ", text: line.slice(1) });
      }
    }
  }

  return files;
}

// ---- Lightweight file summary ----------------------------------------------

export interface DiffFileSummary {
  path: string;
  additions: number;
  removals: number;
}

/**
 * Parse `git diff --numstat` output into file summaries.
 */
export function parseNumstat(raw: string): DiffFileSummary[] {
  if (!raw?.trim()) return [];
  return raw.trim().split("\n").filter(Boolean).map((line) => {
    const [add, rem, ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      additions: add === "-" ? 0 : parseInt(add, 10) || 0,
      removals: rem === "-" ? 0 : parseInt(rem, 10) || 0,
    };
  });
}

/**
 * Get a lightweight list of changed files with +/− counts.
 *
 * @param mode - `"branch"` (default) shows all changes against the base branch
 *               (committed + uncommitted). `"uncommitted"` shows only uncommitted
 *               working-tree changes.
 * @param branch - Optional branch to diff. When provided and not currently
 *                 checked out, only committed changes are included.
 */
export async function getChangedFiles(
  projectDir: string,
  baseBranch = "main",
  mode: "branch" | "uncommitted" = "branch",
  branch?: string,
): Promise<DiffFileSummary[]> {
  const ref = branch ?? "HEAD";
  const hasWorkingTree = await isWorkingTreeAvailable(projectDir, branch);

  // Can't see uncommitted state for a branch that isn't checked out
  if (!hasWorkingTree) {
    if (mode === "uncommitted") return [];
    const committed = await run(projectDir, ["diff", "--numstat", `${baseBranch}...${ref}`]).catch(() => "");
    return parseNumstat(committed);
  }

  // Working tree is available — choose the diff base by mode
  const [numstatBase, untrackedList] = await Promise.all([
    mode === "uncommitted"
      ? Promise.resolve("HEAD")
      : run(projectDir, ["merge-base", baseBranch, "HEAD"])
          .then((s) => s.trim() || baseBranch).catch(() => baseBranch),
    run(projectDir, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);
  const numstat = await run(projectDir, ["diff", "--numstat", numstatBase]).catch(() => "");

  const fileMap = new Map<string, DiffFileSummary>();
  for (const f of parseNumstat(numstat)) {
    fileMap.set(f.path, f);
  }
  const untrackedFiles = untrackedList.trim().split("\n").filter(Boolean);
  for (const filePath of untrackedFiles) {
    if (fileMap.has(filePath)) continue;
    try {
      const content = await Bun.file(`${projectDir}/${filePath}`).text();
      const lineCount = content.split("\n").length;
      fileMap.set(filePath, { path: filePath, additions: lineCount, removals: 0 });
    } catch {
      fileMap.set(filePath, { path: filePath, additions: 0, removals: 0 });
    }
  }
  return [...fileMap.values()];
}

// ---- Build diff (no highlighting) ------------------------------------------

/**
 * Get a fully parsed diff structure with raw text lines (no syntax highlighting).
 * Highlighting is handled client-side.
 *
 * @param mode - `"branch"` (default) shows all changes against the base branch
 *               (committed + uncommitted). `"uncommitted"` shows only uncommitted
 *               working-tree changes.
 * @param branch - Optional branch to diff. When provided and not currently
 *                 checked out, only committed changes are included.
 */
export async function getDiff(
  projectDir: string,
  contextLines = 3,
  baseBranch = "main",
  mode: "branch" | "uncommitted" = "branch",
  branch?: string,
): Promise<DiffFile[]> {
  const raw = await getGitDiff(projectDir, contextLines, baseBranch, mode, branch);
  const parsed = parseUnifiedDiff(raw);

  if (parsed.length === 0) return [];

  return parsed.map((file) => {
    let additions = 0;
    let removals = 0;

    const hunks: DiffHunk[] = file.hunks.map((hunk) => {
      let oldLineNo = hunk.oldStart;
      let newLineNo = hunk.newStart;

      const lines: DiffLine[] = hunk.lines.map((line) => {
        switch (line.prefix) {
          case "+": {
            additions++;
            const result: DiffLine = { type: "add", text: line.text, newLine: newLineNo };
            newLineNo++;
            return result;
          }
          case "-": {
            removals++;
            const result: DiffLine = { type: "remove", text: line.text, oldLine: oldLineNo };
            oldLineNo++;
            return result;
          }
          default: {
            const result: DiffLine = { type: "context", text: line.text, oldLine: oldLineNo, newLine: newLineNo };
            oldLineNo++;
            newLineNo++;
            return result;
          }
        }
      });

      return { header: hunk.header, lines };
    });

    return { path: file.path, additions, removals, hunks };
  });
}
