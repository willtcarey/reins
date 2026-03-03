import { describe, test, expect } from "bun:test";
import { resolveDataDir } from "../db.js";
import { join } from "path";

describe("resolveDataDir", () => {
  test("defaults to .reins under cwd when REINS_DATA_DIR is not set", () => {
    const dir = resolveDataDir({});
    expect(dir).toBe(join(process.cwd(), ".reins"));
  });

  test("uses REINS_DATA_DIR when set", () => {
    const dir = resolveDataDir({ REINS_DATA_DIR: "/data" });
    expect(dir).toBe("/data");
  });

  test("resolves relative REINS_DATA_DIR against cwd", () => {
    const dir = resolveDataDir({ REINS_DATA_DIR: "my-data" });
    expect(dir).toBe(join(process.cwd(), "my-data"));
  });

  test("trims whitespace from REINS_DATA_DIR", () => {
    const dir = resolveDataDir({ REINS_DATA_DIR: "  /data  " });
    expect(dir).toBe("/data");
  });

  test("ignores empty REINS_DATA_DIR", () => {
    const dir = resolveDataDir({ REINS_DATA_DIR: "  " });
    expect(dir).toBe(join(process.cwd(), ".reins"));
  });
});
