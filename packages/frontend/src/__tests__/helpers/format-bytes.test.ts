import { describe, expect, test } from "bun:test";
import { formatBytes } from "../../helpers/format-bytes.js";

describe("formatBytes", () => {
  test("bytes below a KB, then KB and MB to one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MB");
  });
});
