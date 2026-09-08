import { describe, expect, test } from "bun:test";
import { parseFileChanges } from "../../../models/changes/file-changes.js";

const PATCH = `diff --git a/src/old.ts b/src/new.ts
similarity index 88%
rename from src/old.ts
rename to src/new.ts
index 1111111..2222222 100644
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-old
+new
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1 @@
+# Hello
`;

describe("parseFileChanges", () => {
  test("creates sorted file changes with identity and Pierre cache keys", () => {
    const result = parseFileChanges(PATCH, "project-7-v3");

    expect(result.changes.map((change) => change.path)).toEqual(["src/new.ts", "README.md"]);
    expect(result.changes[0]).toMatchObject({
      id: "review:rename-changed:src%2Fold.ts:src%2Fnew.ts:0",
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "rename-changed",
      additions: 1,
      removals: 1,
      occurrence: 0,
    });
    expect(result.changes[0]?.cacheKey).toBe("project-7-v3:rename-changed:src%2Fold.ts:src%2Fnew.ts:0");
    expect(result.changes[0]?.fileDiff.cacheKey).toBe(result.changes[0]?.cacheKey);
    expect(result.changes[0]?.filePatch).toStartWith("diff --git a/src/old.ts b/src/new.ts");
    expect(result.changes[0]?.filePatch).not.toContain("diff --git a/README.md");
    expect(result.pathToChangeId.get("src/new.ts")).toBe(result.changes[0]?.id);
    expect(result.pathToChangeId.get("src/old.ts")).toBe(result.changes[0]?.id);
  });

  test("classifies Git binary changes without treating text files as binary", () => {
    const binaryPatch = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/image.png differ
`;

    expect(parseFileChanges(binaryPatch, "snapshot").changes[0]?.binary).toBe(true);
    expect(parseFileChanges(PATCH, "snapshot").changes.every((change) => !change.binary)).toBe(true);
  });

  test("gives equal content a compact stable identity and changes it with reviewed content", () => {
    const first = parseFileChanges(PATCH, "project-7-v1").changes[0]!;
    const sameContent = parseFileChanges(PATCH, "project-7-v2").changes[0]!;
    const changedContent = parseFileChanges(PATCH.replace("+new", "+updated"), "project-7-v3").changes[0]!;

    expect(first.contentKey).toMatch(/^v1:[0-9a-f]+:[0-9a-z]+$/);
    expect(first.contentKey.length).toBeLessThan(64);
    expect(sameContent.contentKey).toBe(first.contentKey);
    expect(changedContent.contentKey).not.toBe(first.contentKey);
  });

  test("uses occurrence to keep duplicate records unique and reports malformed patches", () => {
    const duplicatePatch = `${PATCH}${PATCH}`;
    const duplicate = parseFileChanges(duplicatePatch, "snapshot");

    expect(new Set(duplicate.changes.map((change) => change.id)).size).toBe(duplicate.changes.length);
    expect(duplicate.changes.filter((change) => change.path === "src/new.ts").map((change) => change.occurrence)).toEqual([0, 1]);

    const malformed = parseFileChanges("diff --git a/a.ts b/a.ts\n@@ invalid\n+x", "snapshot");
    expect(malformed.changes).toEqual([]);
    expect(malformed.parseError).toBeTruthy();
  });
});
