import { describe, test, expect, beforeEach } from "bun:test";
import { isBrowsablePath, toRelativePath, setProjectDir } from "../models/path-utils.js";

beforeEach(() => {
  setProjectDir(null);
});

describe("isBrowsablePath", () => {
  test("accepts simple relative paths", () => {
    expect(isBrowsablePath("src/index.ts")).toBe(true);
    expect(isBrowsablePath("README.md")).toBe(true);
    expect(isBrowsablePath("a/b/c/d.txt")).toBe(true);
  });

  test("accepts dotfiles and hidden directories", () => {
    expect(isBrowsablePath(".gitignore")).toBe(true);
    expect(isBrowsablePath(".github/workflows/ci.yml")).toBe(true);
  });

  test("rejects empty path", () => {
    expect(isBrowsablePath("")).toBe(false);
  });

  test("rejects absolute paths outside project", () => {
    expect(isBrowsablePath("/etc/passwd")).toBe(false);
    expect(isBrowsablePath("/tmp/file.txt")).toBe(false);
    expect(isBrowsablePath("/home/user/project/src/index.ts")).toBe(false);
  });

  test("rejects paths with .. traversal", () => {
    expect(isBrowsablePath("../secret.txt")).toBe(false);
    expect(isBrowsablePath("src/../../etc/passwd")).toBe(false);
    expect(isBrowsablePath("foo/..")).toBe(false);
    expect(isBrowsablePath("..")).toBe(false);
  });

  test("allows paths containing .. in filenames (not traversal)", () => {
    expect(isBrowsablePath("foo..bar")).toBe(true);
    expect(isBrowsablePath("src/file..bak.ts")).toBe(true);
  });

  test("accepts absolute paths inside the project directory", () => {
    setProjectDir("/home/user/project");
    expect(isBrowsablePath("/home/user/project/src/index.ts")).toBe(true);
    expect(isBrowsablePath("/home/user/project/README.md")).toBe(true);
  });

  test("rejects absolute paths outside the project directory", () => {
    setProjectDir("/home/user/project");
    expect(isBrowsablePath("/etc/passwd")).toBe(false);
    expect(isBrowsablePath("/home/user/other/file.ts")).toBe(false);
  });

  test("rejects absolute project paths with .. traversal after prefix", () => {
    setProjectDir("/home/user/project");
    expect(isBrowsablePath("/home/user/project/../other/secret.txt")).toBe(false);
  });
});

describe("toRelativePath", () => {
  test("returns relative paths unchanged", () => {
    expect(toRelativePath("src/index.ts")).toBe("src/index.ts");
    expect(toRelativePath("README.md")).toBe("README.md");
  });

  test("returns absolute paths unchanged when no project dir set", () => {
    expect(toRelativePath("/home/user/project/src/index.ts")).toBe("/home/user/project/src/index.ts");
  });

  test("strips project directory prefix from absolute paths", () => {
    setProjectDir("/home/user/project");
    expect(toRelativePath("/home/user/project/src/index.ts")).toBe("src/index.ts");
    expect(toRelativePath("/home/user/project/README.md")).toBe("README.md");
  });

  test("handles project dir with trailing slash", () => {
    setProjectDir("/home/user/project/");
    expect(toRelativePath("/home/user/project/src/index.ts")).toBe("src/index.ts");
  });

  test("does not strip partial directory name matches", () => {
    setProjectDir("/home/user/proj");
    expect(toRelativePath("/home/user/project/src/index.ts")).toBe("/home/user/project/src/index.ts");
  });

  test("returns empty string for empty input", () => {
    expect(toRelativePath("")).toBe("");
  });

  test("leaves unrelated absolute paths unchanged", () => {
    setProjectDir("/home/user/project");
    expect(toRelativePath("/etc/passwd")).toBe("/etc/passwd");
  });
});
