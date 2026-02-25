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
import {
  detectDefaultBranch,
  createBranch,
  branchExists,
  deleteBranch,
  checkoutBranch,
  getCurrentBranch,
  getSpread,
  getDiffStats,
  getMergedBranches,
  getBranchTip,
  revParse,
  getDiff,
  getChangedFiles,
  rebaseBranch,
  fetchOrigin,
  fetchAll,
  pullBaseBranch,
  fastForwardBaseBranch,
} from "../git.js";

// ---------------------------------------------------------------------------
// detectDefaultBranch
// ---------------------------------------------------------------------------

describe("detectDefaultBranch", () => {
  test("returns 'main' for a repo with a main branch", async () => {
    const repo = await createTestRepo();
    try {
      expect(await detectDefaultBranch(repo.dir)).toBe("main");
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
      expect(await detectDefaultBranch(repo.dir)).toBe("master");
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
      expect(await detectDefaultBranch(repo.dir)).toBe("main");
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
    await createBranch(repo.dir, "feature/test", "main");
    expect(await branchExists(repo.dir, "feature/test")).toBe(true);
  });

  test("branchExists returns false for non-existent branch", async () => {
    expect(await branchExists(repo.dir, "no-such-branch")).toBe(false);
  });

  test("deleteBranch removes a branch", async () => {
    await createBranch(repo.dir, "to-delete", "main");
    expect(await branchExists(repo.dir, "to-delete")).toBe(true);
    await deleteBranch(repo.dir, "to-delete");
    expect(await branchExists(repo.dir, "to-delete")).toBe(false);
  });

  test("createBranch throws when branch already exists", async () => {
    await createBranch(repo.dir, "dup", "main");
    await expect(createBranch(repo.dir, "dup", "main")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkoutBranch / getCurrentBranch
// ---------------------------------------------------------------------------

describe("checkoutBranch / getCurrentBranch", () => {
  const repo = useTestRepo();

  test("round-trip: checkout and getCurrentBranch agree", async () => {
    await createBranch(repo.dir, "feat-1", "main");
    await checkoutBranch(repo.dir, "feat-1");
    expect(await getCurrentBranch(repo.dir)).toBe("feat-1");
  });

  test("starts on main", async () => {
    expect(await getCurrentBranch(repo.dir)).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// getSpread
// ---------------------------------------------------------------------------

describe("getSpread", () => {
  const repo = useTestRepo();

  test("returns 0/0 for a branch at the same commit as base", async () => {
    await createBranch(repo.dir, "feat", "main");
    const spread = await getSpread(repo.dir, "feat", "main");
    expect(spread.aheadBase).toBe(0);
    expect(spread.behindBase).toBe(0);
  });

  test("counts ahead commits correctly", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "a.txt", "a", "commit a");
    await commitFile(repo.dir, "b.txt", "b", "commit b");
    const spread = await getSpread(repo.dir, "feat", "main");
    expect(spread.aheadBase).toBe(2);
    expect(spread.behindBase).toBe(0);
  });

  test("counts behind commits correctly", async () => {
    await createBranch(repo.dir, "feat", "main");
    // Add commits to main
    await commitFile(repo.dir, "c.txt", "c", "commit c");
    const spread = await getSpread(repo.dir, "feat", "main");
    expect(spread.aheadBase).toBe(0);
    expect(spread.behindBase).toBe(1);
  });

  test("remote fields are null when no remote exists", async () => {
    await createBranch(repo.dir, "feat", "main");
    const spread = await getSpread(repo.dir, "feat", "main");
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
    await createBranch(repo.dir, "feat", "main");
    const stats = await getDiffStats(repo.dir, "feat", "main");
    expect(stats.additions).toBe(0);
    expect(stats.removals).toBe(0);
  });

  test("counts additions", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "new.txt", "line1\nline2\nline3\n", "add file");
    const stats = await getDiffStats(repo.dir, "feat", "main");
    expect(stats.additions).toBe(3);
    expect(stats.removals).toBe(0);
  });

  test("counts removals", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    // Overwrite README.md with empty content (removes its line)
    await commitFile(repo.dir, "README.md", "", "clear readme");
    const stats = await getDiffStats(repo.dir, "feat", "main");
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
    await createBranch(repo.dir, "already-merged", "main");
    const merged = await getMergedBranches(repo.dir, "main");
    expect(merged).toContain("already-merged");
  });

  test("does not list a branch with unmerged commits", async () => {
    await createBranch(repo.dir, "unmerged", "main");
    await checkoutBranch(repo.dir, "unmerged");
    await commitFile(repo.dir, "x.txt", "x", "unmerged commit");
    await checkoutBranch(repo.dir, "main");
    const merged = await getMergedBranches(repo.dir, "main");
    expect(merged).not.toContain("unmerged");
  });
});

// ---------------------------------------------------------------------------
// getBranchTip / revParse
// ---------------------------------------------------------------------------

describe("getBranchTip / revParse", () => {
  const repo = useTestRepo();

  test("getBranchTip returns a 40-char SHA for an existing branch", async () => {
    const sha = await getBranchTip(repo.dir, "main");
    expect(sha).not.toBeNull();
    expect(sha!).toMatch(/^[0-9a-f]{40}$/);
  });

  test("getBranchTip returns null for a non-existent branch", async () => {
    const sha = await getBranchTip(repo.dir, "nope");
    expect(sha).toBeNull();
  });

  test("revParse returns same SHA as getBranchTip for same ref", async () => {
    const tip = await getBranchTip(repo.dir, "main");
    const parsed = await revParse(repo.dir, "main");
    expect(parsed).toBe(tip);
  });

  test("revParse works with HEAD", async () => {
    const sha = await revParse(repo.dir, "HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// getDiff
// ---------------------------------------------------------------------------

describe("getDiff", () => {
  const repo = useTestRepo();

  test("returns empty array when branches are identical", async () => {
    await createBranch(repo.dir, "feat", "main");
    const diff = await getDiff(repo.dir, 3, "main", "branch", "feat");
    expect(diff).toEqual([]);
  });

  test("returns DiffFile array with correct structure for additions", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "hello.txt", "hello\nworld\n", "add hello");
    const diff = await getDiff(repo.dir, 3, "main", "branch", "feat");

    expect(diff.length).toBeGreaterThanOrEqual(1);
    const file = diff.find((f) => f.path === "hello.txt");
    expect(file).toBeDefined();
    expect(file!.additions).toBe(2);
    expect(file!.removals).toBe(0);
    expect(file!.hunks.length).toBeGreaterThanOrEqual(1);

    // Check hunk structure
    const hunk = file!.hunks[0];
    expect(hunk.header).toMatch(/^@@/);
    expect(hunk.lines.length).toBeGreaterThan(0);

    // All lines should be additions
    for (const line of hunk.lines) {
      expect(line.type).toBe("add");
      expect(line.newLine).toBeDefined();
    }
  });

  test("returns DiffFile with removals for deleted content", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "README.md", "", "clear readme");
    const diff = await getDiff(repo.dir, 3, "main", "branch", "feat");

    const file = diff.find((f) => f.path === "README.md");
    expect(file).toBeDefined();
    expect(file!.removals).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getChangedFiles
// ---------------------------------------------------------------------------

describe("getChangedFiles", () => {
  const repo = useTestRepo();

  test("returns empty array for identical branches", async () => {
    await createBranch(repo.dir, "feat", "main");
    const files = await getChangedFiles(repo.dir, "main", "branch", "feat");
    expect(files).toEqual([]);
  });

  test("returns file summaries with addition counts", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "new.txt", "one\ntwo\n", "add new");
    const files = await getChangedFiles(repo.dir, "main", "branch", "feat");

    expect(files.length).toBeGreaterThanOrEqual(1);
    const file = files.find((f) => f.path === "new.txt");
    expect(file).toBeDefined();
    expect(file!.additions).toBe(2);
    expect(file!.removals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rebaseBranch
// ---------------------------------------------------------------------------

describe("rebaseBranch", () => {
  const repo = useTestRepo();

  test("successfully rebases a branch onto base", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "feat.txt", "feat", "feat commit");

    // Add a commit to main
    await checkoutBranch(repo.dir, "main");
    await commitFile(repo.dir, "main.txt", "main", "main commit");

    // feat should be 1 behind
    const before = await getSpread(repo.dir, "feat", "main");
    expect(before.behindBase).toBe(1);

    // Rebase feat onto main (we're on main, so it should restore)
    await rebaseBranch(repo.dir, "feat", "main");

    // After rebase, feat should be 0 behind
    const after = await getSpread(repo.dir, "feat", "main");
    expect(after.behindBase).toBe(0);
    expect(after.aheadBase).toBe(1);

    // Should have restored to main
    expect(await getCurrentBranch(repo.dir)).toBe("main");
  });

  test("aborts and restores on conflict", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "README.md", "feat content", "feat change");

    await checkoutBranch(repo.dir, "main");
    await commitFile(repo.dir, "README.md", "main content", "conflicting change");

    // Should throw on conflict
    await expect(rebaseBranch(repo.dir, "feat", "main")).rejects.toThrow();

    // Should restore to main
    expect(await getCurrentBranch(repo.dir)).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// fetchOrigin / fetchAll — no-remote repo
// ---------------------------------------------------------------------------

describe("fetchOrigin / fetchAll (no remote)", () => {
  const repo = useTestRepo();

  test("fetchOrigin returns false when no remote exists", async () => {
    expect(await fetchOrigin(repo.dir, "main")).toBe(false);
  });

  test("fetchAll returns false when no remote exists", async () => {
    expect(await fetchAll(repo.dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pullBaseBranch / fastForwardBaseBranch — with remote
// ---------------------------------------------------------------------------

describe("pullBaseBranch / fastForwardBaseBranch (with remote)", () => {
  const repo = useTestRepo({ withRemote: true });

  test("fetchOrigin returns true when remote exists", async () => {
    expect(await fetchOrigin(repo.dir, "main")).toBe(true);
  });

  test("fetchAll returns true when remote exists", async () => {
    expect(await fetchAll(repo.dir)).toBe(true);
  });

  test("pullBaseBranch fast-forwards local main to match origin", async () => {
    // Create a branch and check it out so we can update main
    await createBranch(repo.dir, "work", "main");
    await checkoutBranch(repo.dir, "work");

    // Simulate a remote advance: commit directly in the bare remote by
    // cloning, committing, pushing from a separate clone
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
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
      const beforeSha = await revParse(repo.dir, "main");
      await pullBaseBranch(repo.dir, "main");
      const afterSha = await revParse(repo.dir, "main");

      // SHA should have advanced
      expect(afterSha).not.toBe(beforeSha);
    } finally {
      const { rmSync } = await import("fs");
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});
