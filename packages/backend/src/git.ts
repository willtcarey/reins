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
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
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

export async function getGitDiff(
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
