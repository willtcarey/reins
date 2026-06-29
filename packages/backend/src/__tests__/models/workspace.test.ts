import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { asyncIterableToText } from "../../async-iterable.js";
import { createBranch, checkoutBranch } from "../../git.js";
import { Workspace } from "../../models/workspace.js";
import { dedent } from "../helpers/text.js";
import { useTestRepo, commitFile, git } from "../helpers/test-repo.js";

async function listTempDiffIndexes(): Promise<Set<string>> {
  const entries = await readdir(tmpdir());
  return new Set(entries.filter((entry) => entry.startsWith("reins-git-index-")));
}

async function expectNoNewTempDiffIndexes(before: Set<string>) {
  const after = await listTempDiffIndexes();
  expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
}

// ---------------------------------------------------------------------------
// getDiffPatchStream
// ---------------------------------------------------------------------------

describe("getDiffPatchStream", () => {
  const repo = useTestRepo();

  test("returns raw patch text for a branch diff", async () => {
    await createBranch(repo.dir, "feature/raw-patch", "main");
    await checkoutBranch(repo.dir, "feature/raw-patch");
    await commitFile(repo.dir, "patch-file.txt", "line 1\nline 2\n", "Add patch file");
    await checkoutBranch(repo.dir, "main");

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(3, "branch", "feature/raw-patch"),
    );

    expect(patch).toBe(dedent`
      diff --git a/patch-file.txt b/patch-file.txt
      new file mode 100644
      index 0000000..7bba8c8
      --- /dev/null
      +++ b/patch-file.txt
      @@ -0,0 +1,2 @@
      +line 1
      +line 2
    `);
  });

  test("includes parent and child changes for an unchecked-out stacked branch", async () => {
    await createBranch(repo.dir, "feature/parent", "main");
    await checkoutBranch(repo.dir, "feature/parent");
    mkdirSync(join(repo.dir, "nested", "parent-dir"), { recursive: true });
    await commitFile(repo.dir, "nested/parent-dir/a.txt", "from parent a\n", "Add parent directory file A");

    await createBranch(repo.dir, "feature/child", "feature/parent");
    await checkoutBranch(repo.dir, "feature/child");
    await commitFile(repo.dir, "child.txt", "from child\n", "Add child file");
    await checkoutBranch(repo.dir, "main");

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(3, "branch", "feature/child"),
    );

    expect(patch).toBe(dedent`
      diff --git a/child.txt b/child.txt
      new file mode 100644
      index 0000000..63bcb0c
      --- /dev/null
      +++ b/child.txt
      @@ -0,0 +1 @@
      +from child
      diff --git a/nested/parent-dir/a.txt b/nested/parent-dir/a.txt
      new file mode 100644
      index 0000000..70ebf70
      --- /dev/null
      +++ b/nested/parent-dir/a.txt
      @@ -0,0 +1 @@
      +from parent a
    `);
  });

  test("returns uncommitted working-tree changes in uncommitted mode", async () => {
    writeFileSync(join(repo.dir, "README.md"), "# Test Repo\nuncommitted line\n");

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(3, "uncommitted"),
    );

    expect(patch).toBe(dedent`
      diff --git a/README.md b/README.md
      index a8cdb91..beb0913 100644
      --- a/README.md
      +++ b/README.md
      @@ -1 +1,2 @@
       # Test Repo
      +uncommitted line
    `);
  });

  test("respects context line count", async () => {
    await commitFile(repo.dir, "context.txt", "line 1\nline 2\nline 3\nline 4\nline 5\n", "Add context file");
    await createBranch(repo.dir, "feature/context-patch", "main");
    await checkoutBranch(repo.dir, "feature/context-patch");
    writeFileSync(join(repo.dir, "context.txt"), "line 1\nline 2\nline THREE\nline 4\nline 5\n");
    await git(repo.dir, ["add", "context.txt"]);
    await git(repo.dir, ["commit", "-m", "Edit context file"]);

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(0, "branch", "feature/context-patch"),
    );

    expect(patch).toBe(dedent`
      diff --git a/context.txt b/context.txt
      index 94c99a3..ddf7aa5 100644
      --- a/context.txt
      +++ b/context.txt
      @@ -3 +3 @@ line 2
      -line 3
      +line THREE
    `);
  });

  test("includes untracked files as Git new-file diffs without staging them", async () => {
    writeFileSync(join(repo.dir, "untracked.txt"), "first\nsecond\n");

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(3, "uncommitted"),
    );

    expect(patch).toBe(dedent`
      diff --git a/untracked.txt b/untracked.txt
      new file mode 100644
      index 0000000..66a52ee
      --- /dev/null
      +++ b/untracked.txt
      @@ -0,0 +1,2 @@
      +first
      +second
    `);
    expect(await git(repo.dir, ["ls-files", "--stage", "--", "untracked.txt"])).toBe("");
    expect(await git(repo.dir, ["status", "--short", "--", "untracked.txt"])).toBe("?? untracked.txt");
  });

  test("streams untracked files in Git's normal path order with tracked changes", async () => {
    await commitFile(repo.dir, "z-file.txt", "old\n", "Add z file");
    writeFileSync(join(repo.dir, "z-file.txt"), "old\nnew\n");
    writeFileSync(join(repo.dir, "a-file.txt"), "added\n");

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(3, "uncommitted"),
    );

    expect(patch.indexOf("diff --git a/a-file.txt b/a-file.txt")).toBeLessThan(
      patch.indexOf("diff --git a/z-file.txt b/z-file.txt"),
    );
  });

  test("keeps ignored untracked files out of raw patches", async () => {
    await commitFile(repo.dir, ".gitignore", "ignored.txt\n", "Ignore file");
    writeFileSync(join(repo.dir, "ignored.txt"), "ignored\n");
    writeFileSync(join(repo.dir, "included.txt"), "included\n");

    const patch = await asyncIterableToText(
      new Workspace(repo.dir).getDiffPatchStream(3, "uncommitted"),
    );

    expect(patch).toContain("diff --git a/included.txt b/included.txt");
    expect(patch).not.toContain("ignored.txt");
    expect(await git(repo.dir, ["ls-files", "--stage", "--", "ignored.txt"])).toBe("");
    expect(await git(repo.dir, ["status", "--short", "--", "ignored.txt"])).toBe("");
  });

  test("cleans up temporary intent-to-add indexes after the patch stream is consumed", async () => {
    writeFileSync(join(repo.dir, "untracked.txt"), "first\nsecond\n");
    const before = await listTempDiffIndexes();

    await asyncIterableToText(new Workspace(repo.dir).getDiffPatchStream(3, "uncommitted"));

    await expectNoNewTempDiffIndexes(before);
  });

  test("cleans up temporary intent-to-add indexes when patch streaming stops early", async () => {
    writeFileSync(join(repo.dir, "untracked.txt"), "first\nsecond\n");
    const before = await listTempDiffIndexes();
    const stream = new Workspace(repo.dir).getDiffPatchStream(3, "uncommitted");
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({ done: false });
    await iterator.return(undefined);

    await expectNoNewTempDiffIndexes(before);
  });
});

// ---------------------------------------------------------------------------
// getDiff
// ---------------------------------------------------------------------------

describe("getDiff", () => {
  const repo = useTestRepo();

  test("returns empty array when branches are identical", async () => {
    await createBranch(repo.dir, "feat", "main");
    const diff = await new Workspace(repo.dir).getDiff(3, "branch", "feat");
    expect(diff).toEqual([]);
  });

});

// ---------------------------------------------------------------------------
// getChangedFiles
// ---------------------------------------------------------------------------

describe("getChangedFiles", () => {
  const repo = useTestRepo();

  test("returns empty array for identical branches", async () => {
    await createBranch(repo.dir, "feat", "main");
    const files = await new Workspace(repo.dir).getChangedFiles("branch", "feat");
    expect(files).toEqual([]);
  });

  test("returns file summaries with addition counts", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "new.txt", "one\ntwo\n", "add new");
    const files = await new Workspace(repo.dir).getChangedFiles("branch", "feat");

    expect(files.length).toBeGreaterThanOrEqual(1);
    const file = files.find((f) => f.path === "new.txt");
    expect(file).toBeDefined();
    expect(file!.additions).toBe(2);
    expect(file!.removals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getDiff / getChangedFiles — committed + uncommitted overlap
// ---------------------------------------------------------------------------

describe("getDiff — committed + uncommitted overlap", () => {
  const repo = useTestRepo();

  test("does not show intermediate state when a line is modified in both committed and uncommitted", async () => {
    // Base has "line1\nline2\nline3", commit changes line2, uncommitted changes it again
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    // Overwrite README.md (base has "# Test Repo\n")
    await commitFile(repo.dir, "README.md", "# Test Repo\ncommitted\n", "edit readme");

    // Further uncommitted edit: replace committed line
    writeFileSync(join(repo.dir, "README.md"), "# Test Repo\nfinal\n");

    const diff = await new Workspace(repo.dir).getDiff(3, "branch");

    const file = diff.find((f) => f.path === "README.md");
    expect(file).toBeDefined();
    // Should show working tree vs base: +final, not both +committed/-committed/+final
    expect(file!.additions).toBe(1);
    expect(file!.removals).toBe(0);

    // Should have exactly 1 hunk, not 2 overlapping ones
    expect(file!.hunks).toHaveLength(1);

    // The intermediate "committed" value should not appear at all
    const allLineTexts = file!.hunks.flatMap((h) => h.lines.map((l) => l.text));
    expect(allLineTexts).not.toContain("committed");
  });

  test("shows correct counts when committed adds a file and uncommitted modifies it", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    await commitFile(repo.dir, "file.txt", "line1\nline2\n", "add file");

    // Uncommitted: modify line2
    writeFileSync(join(repo.dir, "file.txt"), "line1\nchanged\n");

    const diff = await new Workspace(repo.dir).getDiff(3, "branch");

    const file = diff.find((f) => f.path === "file.txt");
    expect(file).toBeDefined();
    // Working tree vs base: new file with "line1\nchanged\n" → 2 additions, 0 removals
    expect(file!.additions).toBe(2);
    expect(file!.removals).toBe(0);
  });

});

describe("getChangedFiles — committed + uncommitted overlap", () => {
  const repo = useTestRepo();

  test("does not inflate counts when a file has both committed and uncommitted changes", async () => {
    await createBranch(repo.dir, "feat", "main");
    await checkoutBranch(repo.dir, "feat");
    // Base has "# Test Repo\n" in README.md. Commit replaces content.
    await commitFile(repo.dir, "README.md", "committed line 1\ncommitted line 2\n", "edit");

    // Uncommitted: modify one of the committed lines
    writeFileSync(join(repo.dir, "README.md"), "committed line 1\nmodified\n");

    const files = await new Workspace(repo.dir).getChangedFiles("branch");

    const file = files.find((f) => f.path === "README.md");
    expect(file).toBeDefined();
    // Working tree vs base: removed "# Test Repo\n", added "committed line 1\nmodified\n"
    // = 2 additions, 1 removal. NOT the sum of committed (2 add, 1 rem) + uncommitted (1 add, 1 rem)
    expect(file!.additions).toBe(2);
    expect(file!.removals).toBe(1);
  });

});

// ---------------------------------------------------------------------------
// workspace diff — untracked files through temporary intent-to-add index
// ---------------------------------------------------------------------------

describe("workspace diff — untracked files through temporary intent-to-add index", () => {
  const repo = useTestRepo();

  test("reports Git numstat additions for text untracked files", async () => {
    writeFileSync(join(repo.dir, "small.txt"), "line1\nline2\nline3\n");

    const files = await new Workspace(repo.dir).getChangedFiles("uncommitted");
    const file = files.find((f) => f.path === "small.txt");
    expect(file).toBeDefined();
    expect(file!.additions).toBe(3);
    expect(file!.removals).toBe(0);
  });

  test("uses Git's numstat ordering for untracked intent-to-add files", async () => {
    await commitFile(repo.dir, "z-file.txt", "old\n", "Add z file");
    writeFileSync(join(repo.dir, "z-file.txt"), "old\nnew\n");
    writeFileSync(join(repo.dir, "a-file.txt"), "added\n");

    const files = await new Workspace(repo.dir).getChangedFiles("uncommitted");

    expect(files.map((file) => file.path)).toEqual(["a-file.txt", "z-file.txt"]);
    expect(await git(repo.dir, ["ls-files", "--stage", "--", "a-file.txt"])).toBe("");
  });

  test("reports Git binary numstat as zero additions/removals", async () => {
    const buf = Buffer.alloc(100);
    buf[50] = 0;
    writeFileSync(join(repo.dir, "image.bin"), buf);

    const files = await new Workspace(repo.dir).getChangedFiles("uncommitted");
    const file = files.find((f) => f.path === "image.bin");
    expect(file).toBeDefined();
    expect(file!.additions).toBe(0);
    expect(file!.removals).toBe(0);
  });

  test("keeps Git-native binary entries instead of synthetic hunks", async () => {
    const buf = Buffer.alloc(100);
    buf[50] = 0;
    writeFileSync(join(repo.dir, "image.bin"), buf);

    const diff = await new Workspace(repo.dir).getDiff(3, "uncommitted");
    const file = diff.find((f) => f.path === "image.bin");
    expect(file).toBeDefined();
    expect(file!.additions).toBe(0);
    expect(file!.removals).toBe(0);
    expect(file!.hunks).toEqual([]);
  });

  test("omits untracked nested repositories that Git cannot represent as intent-to-add", async () => {
    const nestedRepo = join(repo.dir, "repo");
    mkdirSync(nestedRepo, { recursive: true });
    await git(nestedRepo, ["init", "-b", "main"]);
    writeFileSync(join(nestedRepo, "README.md"), "nested repo\n");

    const files = await new Workspace(repo.dir).getChangedFiles("uncommitted");
    const diff = await new Workspace(repo.dir).getDiff(3, "uncommitted");

    expect(files.find((f) => f.path === "repo/")).toBeUndefined();
    expect(diff.find((f) => f.path === "repo/")).toBeUndefined();
  });
});
