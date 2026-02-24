/**
 * Test Git Repository Helper
 *
 * Creates temporary git repositories for testing git operations.
 * Each repo gets an initial commit so branches can be created from it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface TestRepo {
  dir: string;
  cleanup: () => void;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

/**
 * Create a temporary git repo with an initial commit on "main".
 */
export async function createTestRepo(): Promise<TestRepo> {
  const dir = mkdtempSync(join(tmpdir(), "reins-test-"));

  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "Test"]);

  // Initial commit so we have something to branch from
  writeFileSync(join(dir, "README.md"), "# Test Repo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "Initial commit"]);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a test repo with a bare "origin" remote.
 * Useful for testing fetch, push, and remote branch operations.
 */
export async function createTestRepoWithRemote(): Promise<TestRepo & { remoteDir: string }> {
  const remoteDir = mkdtempSync(join(tmpdir(), "reins-test-remote-"));
  await git(remoteDir, ["init", "--bare", "-b", "main"]);

  const dir = mkdtempSync(join(tmpdir(), "reins-test-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["remote", "add", "origin", remoteDir]);

  writeFileSync(join(dir, "README.md"), "# Test Repo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "Initial commit"]);
  await git(dir, ["push", "-u", "origin", "main"]);

  return {
    dir,
    remoteDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    },
  };
}

/**
 * Helper to create a file and commit it in a test repo.
 */
export async function commitFile(
  repoDir: string,
  filePath: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(repoDir, filePath), content);
  await git(repoDir, ["add", filePath]);
  await git(repoDir, ["commit", "-m", message]);
}
