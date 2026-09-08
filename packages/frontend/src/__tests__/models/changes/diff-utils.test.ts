import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  isHtml,
  isImage,
  isMarkdown,
  isPdf,
  shouldWrapLines,
} from "../../../models/changes/diff-utils.js";

describe("file type helpers", () => {
  test("recognizes file-browser preview types case-insensitively", () => {
    expect(isMarkdown("docs/README.MD")).toBe(true);
    expect(isImage("images/photo.JPEG")).toBe(true);
    expect(isPdf("docs/report.PDF")).toBe(true);
    expect(isHtml("public/index.XHTML")).toBe(true);
  });

  test("requires the preview extension at the end of the path", () => {
    expect(isMarkdown("README.md.bak")).toBe(false);
    expect(isImage("photo.png.txt")).toBe(false);
    expect(isPdf("report.pdf.old")).toBe(false);
    expect(isHtml("index.html.erb")).toBe(false);
  });

  test("wraps prose-oriented Markdown source", () => {
    expect(shouldWrapLines("README.md")).toBe(true);
    expect(shouldWrapLines("src/app.ts")).toBe(false);
  });
});

describe("escapeHtml", () => {
  test("escapes markup characters", () => {
    expect(escapeHtml('<a href="&">x</a>')).toBe('&lt;a href="&amp;"&gt;x&lt;/a&gt;');
  });
});
