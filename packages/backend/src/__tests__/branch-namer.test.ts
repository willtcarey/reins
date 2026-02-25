import { describe, test, expect } from "bun:test";
import { slugifyBranchName } from "../branch-namer.js";

describe("slugifyBranchName", () => {
  test("converts a normal title to task/<slug>", () => {
    expect(slugifyBranchName("Add dark mode support")).toBe("task/add-dark-mode-support");
  });

  test("strips special characters", () => {
    expect(slugifyBranchName("Fix bug #123: crash on start!")).toBe("task/fix-bug-123-crash-on-start");
  });

  test("handles already-hyphenated input", () => {
    expect(slugifyBranchName("my-cool-feature")).toBe("task/my-cool-feature");
  });

  test("collapses multiple spaces and hyphens", () => {
    expect(slugifyBranchName("too   many   spaces")).toBe("task/too-many-spaces");
    expect(slugifyBranchName("too---many---hyphens")).toBe("task/too-many-hyphens");
  });

  test("caps length at 50 chars (slug portion)", () => {
    const longTitle = "this is a very long task title that should be truncated to fifty characters";
    const result = slugifyBranchName(longTitle);
    // The slug portion (after "task/") should be at most 50 chars
    const slug = result.replace("task/", "");
    expect(slug.length).toBeLessThanOrEqual(50);
    // Should not end with a hyphen after truncation
    expect(slug).not.toMatch(/-$/);
  });

  test("returns task/untitled for empty string", () => {
    expect(slugifyBranchName("")).toBe("task/untitled");
  });

  test("returns task/untitled for whitespace-only", () => {
    expect(slugifyBranchName("   ")).toBe("task/untitled");
  });

  test("returns task/untitled for special-chars-only", () => {
    expect(slugifyBranchName("!@#$%^&*()")).toBe("task/untitled");
  });

  test("strips unicode characters", () => {
    expect(slugifyBranchName("café résumé")).toBe("task/caf-rsum");
  });

  test("converts to lowercase", () => {
    expect(slugifyBranchName("FIX ALL THE THINGS")).toBe("task/fix-all-the-things");
  });

  test("strips leading and trailing hyphens from slug", () => {
    expect(slugifyBranchName("-leading and trailing-")).toBe("task/leading-and-trailing");
  });
});
