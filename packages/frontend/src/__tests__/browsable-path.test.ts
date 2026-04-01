import { describe, test, expect } from "bun:test";
import { isBrowsablePath } from "../models/path-utils.js";

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

  test("rejects absolute paths", () => {
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
});
