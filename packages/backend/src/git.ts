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
 */
export async function rebaseBranch(
  projectDir: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  // Ensure we're on the target branch
  await runChecked(projectDir, ["checkout", branch]);
  try {
    await runChecked(projectDir, ["rebase", baseBranch]);
  } catch (err) {
    // Abort the in-progress rebase so the repo isn't left in a broken state
    await run(projectDir, ["rebase", "--abort"]);
    throw err;
  }
}

// ---- Working-tree diff -----------------------------------------------------

async function getGitDiff(
  projectDir: string,
  contextLines = 3,
  baseBranch = "main",
): Promise<{ committed: string; uncommitted: string }> {
  const ctxFlag = `-U${contextLines}`;

  const [committed, uncommitted, untrackedList] = await Promise.all([
    run(projectDir, ["diff", ctxFlag, `${baseBranch}...HEAD`]).catch(() => ""),
    run(projectDir, ["diff", ctxFlag, "HEAD"]).catch(() => ""),
    run(projectDir, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);

  // Generate diffs for untracked files so they appear as new files
  let untrackedDiffs = "";
  const untrackedFiles = untrackedList.trim().split("\n").filter(Boolean);
  if (untrackedFiles.length > 0) {
    const diffs = await Promise.all(
      untrackedFiles.map((file) =>
        run(projectDir, ["diff", ctxFlag, "--no-index", "--", "/dev/null", file])
          .catch(() => ""),
      ),
    );
    untrackedDiffs = diffs.filter(Boolean).join("\n");
  }

  const fullUncommitted = [uncommitted, untrackedDiffs].filter(Boolean).join("\n");

  return { committed, uncommitted: fullUncommitted };
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

interface ParsedHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: { prefix: "+" | "-" | " "; text: string }[];
}

interface ParsedFile {
  path: string;
  hunks: ParsedHunk[];
}

function parseUnifiedDiff(raw: string): ParsedFile[] {
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
function parseNumstat(raw: string): DiffFileSummary[] {
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
 */
export async function getChangedFiles(
  projectDir: string,
  baseBranch = "main",
  mode: "branch" | "uncommitted" = "branch",
): Promise<DiffFileSummary[]> {
  const [committed, uncommitted, untrackedList] = await Promise.all([
    mode === "branch"
      ? run(projectDir, ["diff", "--numstat", `${baseBranch}...HEAD`]).catch(() => "")
      : "",
    run(projectDir, ["diff", "--numstat", "HEAD"]).catch(() => ""),
    run(projectDir, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);

  const fileMap = new Map<string, DiffFileSummary>();

  if (mode === "branch") {
    for (const f of parseNumstat(committed)) {
      fileMap.set(f.path, f);
    }
  }
  for (const f of parseNumstat(uncommitted)) {
    const existing = fileMap.get(f.path);
    if (existing) {
      existing.additions += f.additions;
      existing.removals += f.removals;
    } else {
      fileMap.set(f.path, f);
    }
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
 */
export async function getDiff(
  projectDir: string,
  contextLines = 3,
  baseBranch = "main",
  mode: "branch" | "uncommitted" = "branch",
): Promise<DiffFile[]> {
  const rawDiff = await getGitDiff(projectDir, contextLines, baseBranch);
  const parts =
    mode === "uncommitted"
      ? [rawDiff.uncommitted]
      : [rawDiff.committed, rawDiff.uncommitted];
  const combined = parts.filter(Boolean).join("\n");
  const rawParsed = parseUnifiedDiff(combined);

  if (rawParsed.length === 0) return [];

  // Merge duplicate files — the same path can appear in both committed and
  // uncommitted diffs. Combine their hunks into a single entry.
  const mergedMap = new Map<string, ParsedFile>();
  for (const file of rawParsed) {
    const existing = mergedMap.get(file.path);
    if (existing) {
      existing.hunks.push(...file.hunks);
    } else {
      mergedMap.set(file.path, { path: file.path, hunks: [...file.hunks] });
    }
  }
  const parsed = [...mergedMap.values()];

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
