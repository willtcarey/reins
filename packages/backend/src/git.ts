/**
 * Git Operations
 *
 * Utilities for retrieving git diffs from a project directory.
 */

export async function getGitDiff(
  projectDir: string,
  contextLines = 3,
): Promise<{ committed: string; uncommitted: string }> {
  const run = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  };

  const ctxFlag = `-U${contextLines}`;

  const [committed, uncommitted, untrackedList] = await Promise.all([
    run(["diff", ctxFlag, "main...HEAD"]).catch(() => ""),
    run(["diff", ctxFlag, "HEAD"]).catch(() => ""),
    run(["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);

  // Generate diffs for untracked files so they appear as new files
  let untrackedDiffs = "";
  const untrackedFiles = untrackedList.trim().split("\n").filter(Boolean);
  if (untrackedFiles.length > 0) {
    const diffs = await Promise.all(
      untrackedFiles.map((file) =>
        run(["diff", ctxFlag, "--no-index", "--", "/dev/null", file])
          .catch(() => ""),
      ),
    );
    untrackedDiffs = diffs.filter(Boolean).join("\n");
  }

  const fullUncommitted = [uncommitted, untrackedDiffs].filter(Boolean).join("\n");

  return { committed, uncommitted: fullUncommitted };
}
