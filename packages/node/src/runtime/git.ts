import { execFile } from "node:child_process";

/** Node-local git for the session's bound checkout. Errors carry git's stderr, like the server's. */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const exit = typeof error.code === "number" ? error.code : error.code ?? "spawn";
      reject(new Error(`git ${args[0]} failed (exit ${exit}): ${String(stderr).trim() || error.message}`));
    });
  });
}

/** Checks out `branch` in `cwd` only when it is not already the current branch. */
export async function ensureBranchCheckedOut(cwd: string, branch: string): Promise<void> {
  const current = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD";
  if (current !== branch) await runGit(cwd, ["checkout", branch]);
}
