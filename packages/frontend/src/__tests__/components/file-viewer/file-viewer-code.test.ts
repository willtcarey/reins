import { describe, expect, test } from "bun:test";
import {
  LARGE_SOURCE_HIGHLIGHT_THRESHOLD,
  MAX_SOURCE_RENDER_LINES,
  preparePierreSourceFile,
} from "../../../components/file-viewer/file-viewer-code.js";

describe("Pierre source file preparation", () => {
  test("adapts ordinary source content without opting into Pierre's highlight cache", () => {
    const prepared = preparePierreSourceFile("src/app.ts", "export const value = 1;\n");

    expect(prepared.file).toEqual({
      name: "src/app.ts",
      contents: "export const value = 1;\n",
    });
    expect(prepared.truncated).toBe(false);
    expect(prepared.totalLines).toBe(2);
  });

  test("limits rendered lines and reports the original line count", () => {
    const content = Array.from({ length: MAX_SOURCE_RENDER_LINES + 1 }, (_, index) => `line ${index + 1}`).join("\n");
    const prepared = preparePierreSourceFile("notes.txt", content);

    expect(prepared.file.contents.split("\n")).toHaveLength(MAX_SOURCE_RENDER_LINES);
    expect(prepared.totalLines).toBe(MAX_SOURCE_RENDER_LINES + 1);
    expect(prepared.truncated).toBe(true);
  });

  test("forces files over the highlighting threshold to plain text", () => {
    const content = "x".repeat(LARGE_SOURCE_HIGHLIGHT_THRESHOLD + 1);
    const prepared = preparePierreSourceFile("src/large.ts", content);

    expect(prepared.file.lang).toBe("text");
  });
});
