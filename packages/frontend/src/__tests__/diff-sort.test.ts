import { describe, expect, test } from "bun:test";
import { compareFilePaths, sortFileSummaries } from "../models/changes/diff-sort.js";
import type { DiffFileSummary } from "../models/changes/types.js";

function summary(path: string): DiffFileSummary {
  return { path, additions: 0, removals: 0 };
}

describe("changed-file sorting", () => {
  test("orders directories before files and names alphabetically", () => {
    const files = ["README.md", "src/index.ts", "lib/utils.ts", "package.json"].map(summary);

    expect(sortFileSummaries(files).map((file) => file.path)).toEqual([
      "lib/utils.ts",
      "src/index.ts",
      "package.json",
      "README.md",
    ]);
  });

  test("compares paths without mutating source data", () => {
    const files = [summary("b.ts"), summary("a.ts")];
    const sorted = sortFileSummaries(files);

    expect(compareFilePaths("src/a.ts", "a.ts")).toBeLessThan(0);
    expect(files[0].path).toBe("b.ts");
    expect(sorted[0].path).toBe("a.ts");
  });
});
