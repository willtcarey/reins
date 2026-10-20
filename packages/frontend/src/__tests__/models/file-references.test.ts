import { describe, expect, test } from "bun:test";
import { FileReferenceIndex } from "../../models/file-references.js";

const files = [
  "README.md",
  "docs/TODO.md",
  "docs/plans/workspace-inspector.md",
  "packages/frontend/src/components/app.ts",
  "packages/frontend/src/components/chat-message.ts",
  "packages/backend/src/app.ts",
];
const index = new FileReferenceIndex(files, "/home/will/Workspaces/reins");

describe("FileReferenceIndex.resolve", () => {
  test("resolves a full relative path exactly", () => {
    expect(index.resolve("packages/frontend/src/components/chat-message.ts")).toEqual({ path: "packages/frontend/src/components/chat-message.ts" });
    expect(index.resolve("./docs/TODO.md")).toEqual({ path: "docs/TODO.md" });
    expect(index.resolve("frontend/src/components/chat-message.ts")).toBeNull();
    expect(index.resolve("docs/missing.md")).toBeNull();
  });

  test("resolves an absolute path inside the checkout, and nothing outside it", () => {
    expect(index.resolve("/home/will/Workspaces/reins/docs/TODO.md")).toEqual({ path: "docs/TODO.md" });
    expect(index.resolve("/home/will/Workspaces/other/docs/TODO.md")).toBeNull();
    expect(index.resolve("/docs/TODO.md")).toBeNull();
  });

  test("rejects traversal", () => {
    expect(index.resolve("docs/plans/../TODO.md")).toBeNull();
    expect(index.resolve("/home/will/Workspaces/reins/../reins/docs/TODO.md")).toBeNull();
  });

  test("resolves a bare basename only when one file has it", () => {
    expect(index.resolve("chat-message.ts")).toEqual({ path: "packages/frontend/src/components/chat-message.ts" });
    expect(index.resolve("workspace-inspector.md")).toEqual({ path: "docs/plans/workspace-inspector.md" });
    expect(index.resolve("app.ts")).toBeNull();
  });

  test("turns line and line-range suffixes into lines", () => {
    expect(index.resolve("chat-message.ts:127")).toEqual({ path: "packages/frontend/src/components/chat-message.ts", startLine: 127 });
    expect(index.resolve("README.md:12:5")).toEqual({ path: "README.md", startLine: 12 });
    expect(index.resolve("README.md:120-135")).toEqual({ path: "README.md", startLine: 120, endLine: 135 });
    expect(index.resolve("packages/frontend/src/components/app.ts#L120-L135")).toEqual({ path: "packages/frontend/src/components/app.ts", startLine: 120, endLine: 135 });
    expect(index.resolve("README.md#L7")).toEqual({ path: "README.md", startLine: 7 });
  });

  test("leaves URLs alone", () => {
    expect(index.resolve("https://github.com/acme/reins/blob/main/README.md")).toBeNull();
  });
});

describe("FileReferenceIndex.segments", () => {
  test("splits prose into text and references, keeping surrounding punctuation in the text", () => {
    expect(index.segments("See (docs/TODO.md:4), then README.md.")).toEqual([
      "See (",
      { text: "docs/TODO.md:4", reference: { path: "docs/TODO.md", startLine: 4 } },
      "), then ",
      { text: "README.md", reference: { path: "README.md" } },
      ".",
    ]);
  });

  test("takes the longest reference a word holds", () => {
    expect(index.segments("at /home/will/Workspaces/reins/packages/frontend/src/components/app.ts#L3-L9:")).toEqual([
      "at ",
      {
        text: "/home/will/Workspaces/reins/packages/frontend/src/components/app.ts#L3-L9",
        reference: { path: "packages/frontend/src/components/app.ts", startLine: 3, endLine: 9 },
      },
      ":",
    ]);
  });

  test("leaves unresolved, ambiguous and URL text unchanged", () => {
    const text = "app.ts is ambiguous, missing.md is missing, https://example.com/README.md is a URL";
    expect(index.segments(text)).toEqual([text]);
  });

  test("leaves fenced code blocks unchanged", () => {
    expect(index.segments("Edit README.md:\n```\ncat README.md\n```\ndone")).toEqual([
      "Edit ",
      { text: "README.md", reference: { path: "README.md" } },
      ":\n```\ncat README.md\n```\ndone",
    ]);
  });
});
