/**
 * Tests for diff-sort — directory-first, alphabetical file path sorting.
 */
import { describe, test, expect } from "bun:test";
import { sortDiffFiles, sortFileSummaries } from "../changes/diff-sort.js";
import type { DiffFile, DiffFileSummary } from "../changes/types.js";

/** Minimal DiffFile with only the path field populated. */
function diffFile(path: string): DiffFile {
  return { path, additions: 0, removals: 0, hunks: [] };
}

/** Minimal DiffFileSummary with only the path field populated. */
function fileSummary(path: string): DiffFileSummary {
  return { path, additions: 0, removals: 0 };
}

/** Extract paths from sorted results for easy assertion. */
function sortedPaths(paths: string[]): string[] {
  return sortDiffFiles(paths.map(diffFile)).map((f) => f.path);
}

describe("sortDiffFiles", () => {
  test("empty array returns empty", () => {
    expect(sortDiffFiles([])).toEqual([]);
  });

  test("single file passes through", () => {
    const result = sortDiffFiles([diffFile("README.md")]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("README.md");
  });

  test("files in same directory sort alphabetically", () => {
    expect(sortedPaths(["src/beta.ts", "src/alpha.ts", "src/gamma.ts"])).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
    ]);
  });

  test("directories sort before files at the same level", () => {
    expect(sortedPaths(["zebra.ts", "src/index.ts", "alpha.ts"])).toEqual([
      "src/index.ts",
      "alpha.ts",
      "zebra.ts",
    ]);
  });

  test("nested directories maintain directory-first ordering", () => {
    expect(
      sortedPaths([
        "src/utils.ts",
        "src/components/Button.tsx",
        "src/index.ts",
      ]),
    ).toEqual([
      "src/components/Button.tsx",
      "src/index.ts",
      "src/utils.ts",
    ]);
  });

  test("deep nesting (3+ levels)", () => {
    expect(
      sortedPaths([
        "a/b/file.ts",
        "a/b/c/deep.ts",
        "a/b/c/d/deeper.ts",
        "a/file.ts",
      ]),
    ).toEqual([
      "a/b/c/d/deeper.ts",
      "a/b/c/deep.ts",
      "a/b/file.ts",
      "a/file.ts",
    ]);
  });

  test("mixed: root-level files with files in subdirectories", () => {
    expect(
      sortedPaths([
        "README.md",
        "src/index.ts",
        "package.json",
        "lib/utils/helpers.ts",
        "lib/main.ts",
      ]),
    ).toEqual([
      "lib/utils/helpers.ts",
      "lib/main.ts",
      "src/index.ts",
      "package.json",
      "README.md",
    ]);
  });

  test("case sensitivity follows localeCompare", () => {
    // localeCompare is case-insensitive by default in most locales
    const result = sortedPaths(["src/Beta.ts", "src/alpha.ts", "src/gamma.ts"]);
    // alpha < Beta < gamma with default locale compare
    expect(result[0]).toBe("src/alpha.ts");
    expect(result).toHaveLength(3);
  });

  test("does not mutate the original array", () => {
    const original = [diffFile("b.ts"), diffFile("a.ts")];
    const result = sortDiffFiles(original);
    expect(original[0].path).toBe("b.ts");
    expect(result[0].path).toBe("a.ts");
  });

  test("multiple directories at same level sort alphabetically", () => {
    expect(
      sortedPaths([
        "z-dir/file.ts",
        "a-dir/file.ts",
        "m-dir/file.ts",
      ]),
    ).toEqual([
      "a-dir/file.ts",
      "m-dir/file.ts",
      "z-dir/file.ts",
    ]);
  });
});

describe("sortFileSummaries", () => {
  test("empty array returns empty", () => {
    expect(sortFileSummaries([])).toEqual([]);
  });

  test("sorts in directory-first alphabetical order", () => {
    const input = [
      fileSummary("zebra.ts"),
      fileSummary("src/index.ts"),
      fileSummary("alpha.ts"),
    ];
    const result = sortFileSummaries(input);
    expect(result.map((f) => f.path)).toEqual([
      "src/index.ts",
      "alpha.ts",
      "zebra.ts",
    ]);
  });
});

describe("sortDiffFiles and sortFileSummaries consistency", () => {
  test("same paths produce same order from both functions", () => {
    const paths = [
      "README.md",
      "src/components/Button.tsx",
      "src/index.ts",
      "lib/utils.ts",
      "package.json",
    ];

    const diffOrder = sortDiffFiles(paths.map(diffFile)).map((f) => f.path);
    const summaryOrder = sortFileSummaries(paths.map(fileSummary)).map((f) => f.path);

    expect(diffOrder).toEqual(summaryOrder);
  });
});
