/**
 * Git Operations
 *
 * Utilities for retrieving git diffs and branch info from a project directory.
 */

import { highlightLines } from "./highlighter.js";
import { escapeHtml } from "./html-utils.js";

async function run(projectDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
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
 * Read a file blob at a given git ref. Returns null if the file doesn't exist at that ref.
 */
async function readBlob(projectDir: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const content = await run(projectDir, ["show", `${ref}:${filePath}`]);
    return content;
  } catch {
    return null;
  }
}

/**
 * Read the current working-tree version of a file (includes unstaged changes).
 */
async function readWorkingFile(projectDir: string, filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(`${projectDir}/${filePath}`);
    return await file.text();
  } catch {
    return null;
  }
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
 * Create a branch from a base branch without checking it out.
 * Throws if the branch already exists.
 */
export async function createBranch(
  projectDir: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
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
 * Get the current branch name (HEAD).
 */
export async function getCurrentBranch(projectDir: string): Promise<string> {
  const result = await run(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.trim() || "HEAD";
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

// ---- Highlighted diff types ------------------------------------------------

export interface HighlightedDiffLine {
  type: "context" | "add" | "remove";
  html: string;
  oldLine?: number;
  newLine?: number;
}

export interface HighlightedDiffHunk {
  header: string;
  lines: HighlightedDiffLine[];
}

export interface HighlightedDiffFile {
  path: string;
  additions: number;
  removals: number;
  hunks: HighlightedDiffHunk[];
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
      // skip "\ No newline at end of file" and other lines
    }
  }

  return files;
}

// ---- Build highlighted diff ------------------------------------------------

/**
 * Get a fully parsed, syntax-highlighted diff structure ready for the frontend.
 */
export async function getHighlightedDiff(
  projectDir: string,
  contextLines = 3,
  baseBranch = "main",
): Promise<HighlightedDiffFile[]> {
  const rawDiff = await getGitDiff(projectDir, contextLines, baseBranch);
  const combined = [rawDiff.committed, rawDiff.uncommitted].filter(Boolean).join("\n");
  const parsed = parseUnifiedDiff(combined);

  if (parsed.length === 0) return [];

  // Collect unique file paths and read both old/new blobs in parallel
  const filePaths = [...new Set(parsed.map((f) => f.path))];

  const [oldBlobs, newBlobs] = await Promise.all([
    Promise.all(filePaths.map((p) => readBlob(projectDir, baseBranch, p))),
    Promise.all(filePaths.map((p) => readWorkingFile(projectDir, p))),
  ]);

  // Build maps of highlighted lines per file: path → line number (1-based) → html
  const oldHighlighted = new Map<string, string[]>();
  const newHighlighted = new Map<string, string[]>();

  for (let i = 0; i < filePaths.length; i++) {
    const path = filePaths[i];
    if (oldBlobs[i] != null) {
      oldHighlighted.set(path, highlightLines(path, oldBlobs[i]!));
    }
    if (newBlobs[i] != null) {
      newHighlighted.set(path, highlightLines(path, newBlobs[i]!));
    }
  }

  // Assemble the highlighted diff structure
  return parsed.map((file) => {
    const oldLines = oldHighlighted.get(file.path);
    const newLines = newHighlighted.get(file.path);
    let additions = 0;
    let removals = 0;

    const hunks: HighlightedDiffHunk[] = file.hunks.map((hunk) => {
      let oldLineNo = hunk.oldStart;
      let newLineNo = hunk.newStart;

      const lines: HighlightedDiffLine[] = hunk.lines.map((line) => {
        switch (line.prefix) {
          case "+": {
            additions++;
            const html = newLines?.[newLineNo - 1] ?? escapeHtml(line.text);
            const result: HighlightedDiffLine = { type: "add", html, newLine: newLineNo };
            newLineNo++;
            return result;
          }
          case "-": {
            removals++;
            const html = oldLines?.[oldLineNo - 1] ?? escapeHtml(line.text);
            const result: HighlightedDiffLine = { type: "remove", html, oldLine: oldLineNo };
            oldLineNo++;
            return result;
          }
          default: {
            // Context — prefer new file highlighting
            const html = newLines?.[newLineNo - 1] ?? oldLines?.[oldLineNo - 1] ?? escapeHtml(line.text);
            const result: HighlightedDiffLine = { type: "context", html, oldLine: oldLineNo, newLine: newLineNo };
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


