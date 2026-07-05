import { describe, expect, test } from "bun:test";
import { DiffFileCard } from "../../../components/changes/diff-file-card.js";
import type { DiffFile } from "../../../models/changes/types.js";
import { templateToString } from "../../helpers/lit-template.js";

function file(path: string): DiffFile {
  return {
    path,
    additions: 1,
    removals: 0,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: [{ type: "add", text: "hello", newLine: 1 }],
      },
    ],
  };
}

describe("DiffFileCard file actions", () => {
  test("uses shared file action buttons", () => {
    const card = new DiffFileCard();
    card.file = file("src/app.ts");
    card.projectId = 1;

    const output = templateToString(card.render());

    expect(output).toContain("<diff-view-file-button");
    expect(output).toContain("<diff-copy-path-button");
    expect(output).toContain("<diff-download-file-button");
    expect(output).toContain("/api/projects/1/files/content?path=src%2Fapp.ts");
  });
});
