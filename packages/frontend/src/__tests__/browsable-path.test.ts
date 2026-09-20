import { describe, expect, test } from "bun:test";
import { isBrowsablePath, toRelativePath } from "../models/path-utils.js";

const projectDir = "/home/user/project";

describe("isBrowsablePath", () => {
  test("accepts safe relative paths without project context", () => {
    expect(isBrowsablePath("src/index.ts", null)).toBe(true);
    expect(isBrowsablePath(".github/workflows/ci.yml", null)).toBe(true);
    expect(isBrowsablePath("foo..bar", null)).toBe(true);
  });

  test("rejects empty, external absolute, and traversing paths", () => {
    expect(isBrowsablePath("", projectDir)).toBe(false);
    expect(isBrowsablePath("/etc/passwd", projectDir)).toBe(false);
    expect(isBrowsablePath("../secret.txt", projectDir)).toBe(false);
    expect(isBrowsablePath("src/../../etc/passwd", projectDir)).toBe(false);
  });

  test("accepts absolute paths only inside the explicit project directory", () => {
    expect(isBrowsablePath("/home/user/project/src/index.ts", projectDir)).toBe(true);
    expect(isBrowsablePath("/home/user/other/file.ts", projectDir)).toBe(false);
    expect(isBrowsablePath("/home/user/project/../other/secret.txt", projectDir)).toBe(false);
  });
});

describe("toRelativePath", () => {
  test("returns relative and empty paths unchanged", () => {
    expect(toRelativePath("src/index.ts", projectDir)).toBe("src/index.ts");
    expect(toRelativePath("", projectDir)).toBe("");
  });

  test("requires explicit matching project context to strip an absolute path", () => {
    expect(toRelativePath("/home/user/project/src/index.ts", null)).toBe("/home/user/project/src/index.ts");
    expect(toRelativePath("/home/user/project/src/index.ts", projectDir)).toBe("src/index.ts");
    expect(toRelativePath("/home/user/project/src/index.ts", `${projectDir}/`)).toBe("src/index.ts");
    expect(toRelativePath("/home/user/project/src/index.ts", "/home/user/proj")).toBe("/home/user/project/src/index.ts");
    expect(toRelativePath("/etc/passwd", projectDir)).toBe("/etc/passwd");
  });
});
