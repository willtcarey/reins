import { describe, expect, test } from "bun:test";
import { DiffParser } from "../../models/diff-parser.js";
import { dedent } from "../helpers/text.js";

describe("parseUnifiedDiff", () => {
  test("returns empty array for empty input", () => {
    expect(DiffParser.parseUnifiedDiff("")).toEqual([]);
    expect(DiffParser.parseUnifiedDiff("   ")).toEqual([]);
    expect(DiffParser.parseUnifiedDiff("\n\n")).toEqual([]);
  });

  test("parses a single file with a single hunk", () => {
    const diff = dedent`
      diff --git a/file.ts b/file.ts
      index abc1234..def5678 100644
      --- a/file.ts
      +++ b/file.ts
      @@ -1,3 +1,4 @@
       line one
      +added line
       line two
       line three
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("file.ts");
    expect(result[0].hunks).toHaveLength(1);

    const hunk = result[0].hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toEqual([
      { prefix: " ", text: "line one" },
      { prefix: "+", text: "added line" },
      { prefix: " ", text: "line two" },
      { prefix: " ", text: "line three" },
    ]);
  });

  test("parses multiple files", () => {
    const diff = dedent`
      diff --git a/a.ts b/a.ts
      --- a/a.ts
      +++ b/a.ts
      @@ -1,2 +1,2 @@
      -old a
      +new a
       unchanged
      diff --git a/b.ts b/b.ts
      --- a/b.ts
      +++ b/b.ts
      @@ -1,2 +1,3 @@
       first
      +inserted
       last
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("a.ts");
    expect(result[1].path).toBe("b.ts");
  });

  test("parses multiple hunks in one file", () => {
    const diff = dedent`
      diff --git a/file.ts b/file.ts
      --- a/file.ts
      +++ b/file.ts
      @@ -1,3 +1,3 @@
      -old first
      +new first
       middle
       end
      @@ -10,3 +10,3 @@
       start
      -old second
      +new second
       finish
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(2);
    expect(result[0].hunks[0].oldStart).toBe(1);
    expect(result[0].hunks[0].newStart).toBe(1);
    expect(result[0].hunks[1].oldStart).toBe(10);
    expect(result[0].hunks[1].newStart).toBe(10);
  });

  test("parses add-only diff", () => {
    const diff = dedent`
      diff --git a/new.ts b/new.ts
      new file mode 100644
      --- /dev/null
      +++ b/new.ts
      @@ -0,0 +1,3 @@
      +line one
      +line two
      +line three
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("new.ts");
    const lines = result[0].hunks[0].lines;
    expect(lines.every((l) => l.prefix === "+")).toBe(true);
    expect(lines).toHaveLength(3);
  });

  test("parses remove-only diff", () => {
    const diff = dedent`
      diff --git a/deleted.ts b/deleted.ts
      deleted file mode 100644
      --- a/deleted.ts
      +++ /dev/null
      @@ -1,2 +0,0 @@
      -line one
      -line two
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    const lines = result[0].hunks[0].lines;
    expect(lines.every((l) => l.prefix === "-")).toBe(true);
    expect(lines).toHaveLength(2);
  });

  test("parses renamed file", () => {
    const diff = dedent`
      diff --git a/old-name.ts b/new-name.ts
      similarity index 90%
      rename from old-name.ts
      rename to new-name.ts
      --- a/old-name.ts
      +++ b/new-name.ts
      @@ -1,3 +1,3 @@
       same
      -old
      +new
       same
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("new-name.ts");
  });

  test("skips binary files metadata lines", () => {
    const diff = dedent`
      diff --git a/image.png b/image.png
      Binary files a/image.png and b/image.png differ
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    // File entry is created but with no hunks
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(0);
  });

  test("parses hunk headers with function context", () => {
    const diff = dedent`
      diff --git a/file.ts b/file.ts
      --- a/file.ts
      +++ b/file.ts
      @@ -5,7 +5,8 @@ function foo() {
       context
      +added
       more
    `;

    const result = DiffParser.parseUnifiedDiff(diff);
    const hunk = result[0].hunks[0];
    expect(hunk.oldStart).toBe(5);
    expect(hunk.newStart).toBe(5);
    expect(hunk.header).toContain("function foo()");
  });
});

describe("parseNumstat", () => {
  test("returns empty array for empty input", () => {
    expect(DiffParser.parseNumstat("")).toEqual([]);
    expect(DiffParser.parseNumstat("   ")).toEqual([]);
    expect(DiffParser.parseNumstat("\n")).toEqual([]);
  });

  test("parses single file", () => {
    const result = DiffParser.parseNumstat("10\t5\tfile.ts");
    expect(result).toEqual([{ path: "file.ts", additions: 10, removals: 5 }]);
  });

  test("parses multiple files", () => {
    const raw = "10\t5\ta.ts\n3\t0\tb.ts\n0\t7\tc.ts";
    const result = DiffParser.parseNumstat(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ path: "a.ts", additions: 10, removals: 5 });
    expect(result[1]).toEqual({ path: "b.ts", additions: 3, removals: 0 });
    expect(result[2]).toEqual({ path: "c.ts", additions: 0, removals: 7 });
  });

  test("handles binary entries (- - path)", () => {
    const result = DiffParser.parseNumstat("-\t-\timage.png");
    expect(result).toEqual([{ path: "image.png", additions: 0, removals: 0 }]);
  });

  test("handles paths with tabs (e.g. renamed files)", () => {
    const result = DiffParser.parseNumstat("5\t3\told name.ts\textra");
    // pathParts.join("\t") preserves the full path
    expect(result[0].path).toBe("old name.ts\textra");
  });

  test("skips blank lines", () => {
    const raw = "10\t5\ta.ts\n\n3\t0\tb.ts\n";
    const result = DiffParser.parseNumstat(raw);
    expect(result).toHaveLength(2);
  });
});


describe("DiffParser.parsePatch", () => {
  test("returns DiffFile records with additions, removals, and line numbers", () => {
    const diff = dedent`
      diff --git a/file.ts b/file.ts
      --- a/file.ts
      +++ b/file.ts
      @@ -2,3 +2,3 @@
       unchanged
      -old line
      +new line
    `;

    expect(DiffParser.parsePatch(diff)).toEqual([
      {
        path: "file.ts",
        additions: 1,
        removals: 1,
        hunks: [
          {
            header: "@@ -2,3 +2,3 @@",
            lines: [
              { type: "context", text: "unchanged", oldLine: 2, newLine: 2 },
              { type: "remove", text: "old line", oldLine: 3 },
              { type: "add", text: "new line", newLine: 3 },
            ],
          },
        ],
      },
    ]);
  });
});
