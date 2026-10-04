/**
 * Git utilities — contract tests
 *
 * Tests the exported git operations against real temporary repositories.
 */

import { describe, test, expect } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  createTestRepo,
  commitFile,
  useTestRepo,
} from "./helpers/test-repo.js";
import { localGit } from "./helpers/local-git.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

describe("git module public API", () => {
  test("does not export low-level unchecked runGit", async () => {
    const gitModule = await import("../git.js");
    expect(Object.hasOwn(gitModule, "runGit")).toBe(false);
  });

  test("a diff with untracked files uses its own temporary index, not one inherited from the environment", async () => {
    const repo = await createTestRepo();
    const previousGitIndexFile = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_INDEX_FILE = join(repo.dir, "missing-parent-index");
      writeFileSync(join(repo.dir, "README.md"), "# Test Repo\nchanged\n");

      const numstat = await localGit(repo.dir).getDiffNumstat("HEAD", { untracked: true });

      expect(numstat.trim()).toBe("1\t0\tREADME.md");
    } finally {
      if (previousGitIndexFile === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previousGitIndexFile;
      }
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// detectDefaultBranch
// ---------------------------------------------------------------------------

describe("detectDefaultBranch", () => {
  test("returns 'main' for a repo with a main branch", async () => {
    const repo = await createTestRepo();
    try {
      expect(await localGit(repo.dir).detectDefaultBranch()).toBe("main");
    } finally {
      repo.cleanup();
    }
  });

  test("returns 'master' when only master exists", async () => {
    const repo = await createTestRepo();
    try {
      // Rename main → master
      const proc = Bun.spawn(["git", "branch", "-m", "main", "master"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
      expect(await localGit(repo.dir).detectDefaultBranch()).toBe("master");
    } finally {
      repo.cleanup();
    }
  });

  test("falls back to 'main' when no candidate branch exists", async () => {
    const repo = await createTestRepo();
    try {
      // Rename main → something-else
      const proc = Bun.spawn(["git", "branch", "-m", "main", "something-else"], {
        cwd: repo.dir, stdout: "pipe", stderr: "pipe",
      });
      await proc.exited;
      expect(await localGit(repo.dir).detectDefaultBranch()).toBe("main");
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Branch lifecycle: createBranch, branchExists, deleteBranch
// ---------------------------------------------------------------------------

describe("branch lifecycle", () => {
  const repo = useTestRepo();

  test("createBranch creates a branch that exists", async () => {
    await localGit(repo.dir).createBranch("feature/test", "main");
    expect(await localGit(repo.dir).branchExists("feature/test")).toBe(true);
  });

  test("branchExists returns false for non-existent branch", async () => {
    expect(await localGit(repo.dir).branchExists("no-such-branch")).toBe(false);
  });

  test("deleteBranch removes a branch", async () => {
    await localGit(repo.dir).createBranch("to-delete", "main");
    expect(await localGit(repo.dir).branchExists("to-delete")).toBe(true);
    await localGit(repo.dir).deleteBranch("to-delete");
    expect(await localGit(repo.dir).branchExists("to-delete")).toBe(false);
  });

  test("createBranch throws when branch already exists", async () => {
    await localGit(repo.dir).createBranch("dup", "main");
    await expect(localGit(repo.dir).createBranch("dup", "main")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkoutBranch / getCurrentBranch
// ---------------------------------------------------------------------------

describe("checkoutBranch / getCurrentBranch", () => {
  const repo = useTestRepo();

  test("round-trip: checkout and getCurrentBranch agree", async () => {
    await localGit(repo.dir).createBranch("feat-1", "main");
    await localGit(repo.dir).checkoutBranch("feat-1");
    expect(await localGit(repo.dir).getCurrentBranch()).toBe("feat-1");
  });

  test("starts on main", async () => {
    expect(await localGit(repo.dir).getCurrentBranch()).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// getSpread
// ---------------------------------------------------------------------------

describe("getSpread", () => {
  const repo = useTestRepo();

  test("returns 0/0 for a branch at the same commit as base", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    const spread = await localGit(repo.dir).getSpread("feat", "main");
    expect(spread.aheadBase).toBe(0);
    expect(spread.behindBase).toBe(0);
  });

  test("counts ahead commits correctly", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    await localGit(repo.dir).checkoutBranch("feat");
    await commitFile(repo.dir, "a.txt", "a", "commit a");
    await commitFile(repo.dir, "b.txt", "b", "commit b");
    const spread = await localGit(repo.dir).getSpread("feat", "main");
    expect(spread.aheadBase).toBe(2);
    expect(spread.behindBase).toBe(0);
  });

  test("counts behind commits correctly", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    // Add commits to main
    await commitFile(repo.dir, "c.txt", "c", "commit c");
    const spread = await localGit(repo.dir).getSpread("feat", "main");
    expect(spread.aheadBase).toBe(0);
    expect(spread.behindBase).toBe(1);
  });

  test("remote fields are null when no remote exists", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    const spread = await localGit(repo.dir).getSpread("feat", "main");
    expect(spread.aheadRemote).toBeNull();
    expect(spread.behindRemote).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDiffStats
// ---------------------------------------------------------------------------

describe("getDiffStats", () => {
  const repo = useTestRepo();

  test("returns 0/0 for identical branches", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    const stats = await localGit(repo.dir).getDiffStats("feat", "main");
    expect(stats.additions).toBe(0);
    expect(stats.removals).toBe(0);
  });

  test("counts additions", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    await localGit(repo.dir).checkoutBranch("feat");
    await commitFile(repo.dir, "new.txt", "line1\nline2\nline3\n", "add file");
    const stats = await localGit(repo.dir).getDiffStats("feat", "main");
    expect(stats.additions).toBe(3);
    expect(stats.removals).toBe(0);
  });

  test("counts removals", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    await localGit(repo.dir).checkoutBranch("feat");
    // Overwrite README.md with empty content (removes its line)
    await commitFile(repo.dir, "README.md", "", "clear readme");
    const stats = await localGit(repo.dir).getDiffStats("feat", "main");
    expect(stats.removals).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getMergedBranches
// ---------------------------------------------------------------------------

describe("getMergedBranches", () => {
  const repo = useTestRepo();

  test("detects a branch whose tip is reachable from base", async () => {
    // A branch with no additional commits is trivially merged
    await localGit(repo.dir).createBranch("already-merged", "main");
    const merged = await localGit(repo.dir).getMergedBranches("main");
    expect(merged).toContain("already-merged");
  });

  test("does not list a branch with unmerged commits", async () => {
    await localGit(repo.dir).createBranch("unmerged", "main");
    await localGit(repo.dir).checkoutBranch("unmerged");
    await commitFile(repo.dir, "x.txt", "x", "unmerged commit");
    await localGit(repo.dir).checkoutBranch("main");
    const merged = await localGit(repo.dir).getMergedBranches("main");
    expect(merged).not.toContain("unmerged");
  });
});

// ---------------------------------------------------------------------------
// getBranchTip / revParse
// ---------------------------------------------------------------------------

describe("getBranchTip / revParse", () => {
  const repo = useTestRepo();

  test("getBranchTip returns a 40-char SHA for an existing branch", async () => {
    const sha = await localGit(repo.dir).getBranchTip("main");
    expect(sha).not.toBeNull();
    expect(sha!).toMatch(/^[0-9a-f]{40}$/);
  });

  test("getBranchTip returns null for a non-existent branch", async () => {
    const sha = await localGit(repo.dir).getBranchTip("nope");
    expect(sha).toBeNull();
  });

  test("revParse returns same SHA as getBranchTip for same ref", async () => {
    const tip = await localGit(repo.dir).getBranchTip("main");
    const parsed = await localGit(repo.dir).revParse("main");
    expect(parsed).toBe(tip!);
  });

  test("revParse works with HEAD", async () => {
    const sha = await localGit(repo.dir).revParse("HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// rebaseBranch
// ---------------------------------------------------------------------------

describe("rebaseBranch", () => {
  const repo = useTestRepo();

  test("successfully rebases a branch onto base", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    await localGit(repo.dir).checkoutBranch("feat");
    await commitFile(repo.dir, "feat.txt", "feat", "feat commit");

    // Add a commit to main
    await localGit(repo.dir).checkoutBranch("main");
    await commitFile(repo.dir, "main.txt", "main", "main commit");

    // feat should be 1 behind
    const before = await localGit(repo.dir).getSpread("feat", "main");
    expect(before.behindBase).toBe(1);

    // Rebase feat onto main (we're on main, so it should restore)
    await localGit(repo.dir).rebaseBranch("feat", "main");

    // After rebase, feat should be 0 behind
    const after = await localGit(repo.dir).getSpread("feat", "main");
    expect(after.behindBase).toBe(0);
    expect(after.aheadBase).toBe(1);

    // Should have restored to main
    expect(await localGit(repo.dir).getCurrentBranch()).toBe("main");
  });

  test("aborts and restores on conflict", async () => {
    await localGit(repo.dir).createBranch("feat", "main");
    await localGit(repo.dir).checkoutBranch("feat");
    await commitFile(repo.dir, "README.md", "feat content", "feat change");

    await localGit(repo.dir).checkoutBranch("main");
    await commitFile(repo.dir, "README.md", "main content", "conflicting change");

    // Should throw on conflict
    await expect(localGit(repo.dir).rebaseBranch("feat", "main")).rejects.toThrow();

    // Should restore to main
    expect(await localGit(repo.dir).getCurrentBranch()).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// fetchOrigin / fetchAll — no-remote repo
// ---------------------------------------------------------------------------

describe("fetchOrigin / fetchAll (no remote)", () => {
  const repo = useTestRepo();

  test("fetchOrigin returns false when no remote exists", async () => {
    expect(await localGit(repo.dir).fetchOrigin("main")).toBe(false);
  });

  test("fetchAll returns false when no remote exists", async () => {
    expect(await localGit(repo.dir).fetchAll()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pullBaseBranch / fastForwardBaseBranch — with remote
// ---------------------------------------------------------------------------

describe("pullBaseBranch / fastForwardBaseBranch (with remote)", () => {
  const repo = useTestRepo({ withRemote: true });

  test("fetchOrigin returns true when remote exists", async () => {
    expect(await localGit(repo.dir).fetchOrigin("main")).toBe(true);
  });

  test("fetchAll returns true when remote exists", async () => {
    expect(await localGit(repo.dir).fetchAll()).toBe(true);
  });

  test("pullBaseBranch fast-forwards local main to match origin", async () => {
    // Create a branch and check it out so we can update main
    await localGit(repo.dir).createBranch("work", "main");
    await localGit(repo.dir).checkoutBranch("work");

    // Simulate a remote advance: commit directly in the bare remote by
    // cloning, committing, pushing from a separate clone
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const cloneDir = mkdtempSync(join(tmpdir(), "reins-test-clone-"));
    try {
      const proc1 = Bun.spawn(["git", "clone", repo.remoteDir, cloneDir], {
        stdout: "pipe", stderr: "pipe",
      });
      await proc1.exited;

      // Configure clone
      const cfg1 = Bun.spawn(["git", "config", "user.email", "test@test.com"], {
        cwd: cloneDir, stdout: "pipe", stderr: "pipe",
      });
      await cfg1.exited;
      const cfg2 = Bun.spawn(["git", "config", "user.name", "Test"], {
        cwd: cloneDir, stdout: "pipe", stderr: "pipe",
      });
      await cfg2.exited;

      await commitFile(cloneDir, "remote-file.txt", "remote", "remote commit");
      const push = Bun.spawn(["git", "push", "origin", "main"], {
        cwd: cloneDir, stdout: "pipe", stderr: "pipe",
      });
      await push.exited;

      // Now our local main should be behind origin/main
      const beforeSha = await localGit(repo.dir).revParse("main");
      await localGit(repo.dir).pullBaseBranch("main");
      const afterSha = await localGit(repo.dir).revParse("main");

      // SHA should have advanced
      expect(afterSha).not.toBe(beforeSha);
    } finally {
      const { rmSync } = await import("fs");
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mergeBase
// ---------------------------------------------------------------------------

describe("mergeBase", () => {
  const repo = useTestRepo();

  test("returns the fork-point SHA, not the tip of either branch", async () => {
    // Record the SHA before any diverging commits — this is the expected merge-base
    const forkPoint = await localGit(repo.dir).revParse("HEAD");

    // Create a feature branch and add a commit there
    await localGit(repo.dir).createBranch("feat", "main");
    await localGit(repo.dir).checkoutBranch("feat");
    await commitFile(repo.dir, "feat.txt", "feature work", "feat commit");

    // Go back to main and add a commit there too (so branches diverge)
    await localGit(repo.dir).checkoutBranch("main");
    await commitFile(repo.dir, "main.txt", "main work", "main commit");

    // mergeBase should return the original fork-point, not tip of either branch
    const result = await localGit(repo.dir).mergeBase("main", "feat");
    expect(result).toBe(forkPoint);
    expect(result).not.toBe(await localGit(repo.dir).revParse("main"));
    expect(result).not.toBe(await localGit(repo.dir).revParse("feat"));
  });
});

// ---------------------------------------------------------------------------
// trackBranch
// ---------------------------------------------------------------------------

describe("trackBranch", () => {
  const repo = useTestRepo({ withRemote: true });

  test("creates a local tracking branch from origin/<branch>", async () => {
    // Create and push a feature branch to origin
    await localGit(repo.dir).createBranch("feat-remote", "main");
    await localGit(repo.dir).checkoutBranch("feat-remote");
    await commitFile(repo.dir, "remote.txt", "remote content", "remote commit");
    const pushedSha = await localGit(repo.dir).revParse("HEAD");

    // Push to origin, then delete local branch
    const push = Bun.spawn(["git", "push", "origin", "feat-remote"], {
      cwd: repo.dir, stdout: "pipe", stderr: "pipe",
    });
    await push.exited;
    await localGit(repo.dir).checkoutBranch("main");
    await localGit(repo.dir).deleteBranch("feat-remote");
    expect(await localGit(repo.dir).branchExists("feat-remote")).toBe(false);

    // trackBranch should recreate it locally
    await localGit(repo.dir).trackBranch("feat-remote");
    expect(await localGit(repo.dir).branchExists("feat-remote")).toBe(true);
    expect(await localGit(repo.dir).revParse("feat-remote")).toBe(pushedSha);
  });
});
