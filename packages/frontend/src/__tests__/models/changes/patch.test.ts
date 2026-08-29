import { describe, expect, test } from "bun:test";
import {
  extractFile,
  reversePatch,
} from "../../../models/changes/patch.js";

describe("reversePatch", () => {
  test("reconstructs the old file from complete new text across multiple hunks", () => {
    const patch = `diff --git a/story.txt b/story.txt
index 1111111..2222222 100644
--- a/story.txt
+++ b/story.txt
@@ -2,4 +2,4 @@ one
 two
-three
+THREE
 four
 five
@@ -8,2 +8,3 @@ seven
 eight
-nine
+nine-a
+nine-b
`;
    const newFile = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine-a\nnine-b\nten\n";

    expect(reversePatch(patch, newFile)).toBe(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
  });

  test("handles insertion-only and deletion-only zero-length ranges", () => {
    const inserted = `diff --git a/empty.txt b/empty.txt
index e69de29..1111111 100644
--- a/empty.txt
+++ b/empty.txt
@@ -0,0 +1,2 @@
+first
+second
`;
    const deleted = `diff --git a/old.txt b/old.txt
index 1111111..e69de29 100644
--- a/old.txt
+++ b/old.txt
@@ -1,2 +0,0 @@
-first
-second
`;

    expect(reversePatch(inserted, "first\nsecond\n")).toBe("");
    expect(reversePatch(deleted, "")).toBe("first\nsecond\n");
  });

  test("preserves no-newline-at-EOF markers on either side", () => {
    const patch = `diff --git a/note.txt b/note.txt
index 1111111..2222222 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-old ending
\\ No newline at end of file
+new ending
\\ No newline at end of file
`;

    expect(reversePatch(patch, "new ending")).toBe("old ending");
  });

  test("rejects stale context or addition content instead of returning a plausible old file", () => {
    const patch = `diff --git a/story.txt b/story.txt
index 1111111..2222222 100644
--- a/story.txt
+++ b/story.txt
@@ -1,2 +1,2 @@
 context
-old
+new
`;

    expect(() => reversePatch(patch, "stale\nnew\n")).toThrow("does not match");
    expect(() => reversePatch(patch, "context\nstale\n")).toThrow("does not match");
  });
});

describe("extractFile", () => {
  test("derives complete new and deleted file sides, including empty unavailable sides", () => {
    const added = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
`;
    const deleted = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
\\ No newline at end of file
`;

    expect(extractFile(added, "old")).toBe("");
    expect(extractFile(added, "new")).toBe("hello\nworld");
    expect(extractFile(deleted, "new")).toBe("");
    expect(extractFile(deleted, "old")).toBe("first\nsecond");
  });

  test("derives both sides of empty one-sided files from mode-only patches", () => {
    const added = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`;
    const deleted = `diff --git a/empty.txt b/empty.txt
deleted file mode 100644
index e69de29..0000000
`;

    expect(extractFile(added, "old")).toBe("");
    expect(extractFile(added, "new")).toBe("");
    expect(extractFile(deleted, "old")).toBe("");
    expect(extractFile(deleted, "new")).toBe("");
  });
});
