import { describe, expect, test } from "bun:test";
import { ReviewDiffItem } from "../../../components/changes/review-diff-item.js";
import { parseReviewItems } from "../../../models/changes/review-items.js";
import {
  collectTemplateEventListeners,
  templateToString,
} from "../../helpers/lit-template.js";

const PATCH = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new
`;

describe("ReviewDiffItem", () => {
  test("renders a Reins-owned file header, shared file actions, and Pierre text-diff surface", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const item = new ReviewDiffItem();
    item.item = parsed.items[0] ?? null;
    item.projectId = 7;
    item.branch = "task/example";

    const output = templateToString(item.render());

    expect(output).toContain("src/example.ts");
    expect(output).toContain("<header");
    expect(output).toContain(">+1</span>");
    expect(output).toContain(">-1</span>");
    expect(output.indexOf(">-1</span>")).toBeLessThan(output.indexOf("<diff-view-file-button"));
    expect(output).toContain("<diff-view-file-button .path=src/example.ts variant=\"header\">");
    expect(output).toContain("<diff-copy-path-button .path=src/example.ts variant=\"header\">");
    expect(output).toContain("<diff-download-file-button");
    expect(output).toContain(".path=src/example.ts");
    expect(output).toContain(".href=/api/projects/7/files/content?path=src%2Fexample.ts&ref=task%2Fexample");
    expect(output).toContain("<diffs-container data-pierre-file-diff>");
  });

  test("renders an accessible collapse control and hides only the diff body when collapsed", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const reviewItem = parsed.items[0]!;
    const item = new ReviewDiffItem();
    item.item = { ...reviewItem, collapsed: true };
    const toggledIds: string[] = [];
    item.addEventListener("toggle-collapse", (event) => {
      if (event instanceof CustomEvent) toggledIds.push(event.detail);
    });

    const rendered = item.render();
    const output = templateToString(rendered);
    collectTemplateEventListeners(rendered, "click")[0]?.call(item, new Event("click"));

    expect(output).toContain(`<button`);
    expect(output).toContain(`aria-label=Expand src/example.ts`);
    expect(output).toContain(`aria-expanded=false`);
    expect(output).toContain("src/example.ts");
    expect(output).not.toContain("<diffs-container data-pierre-file-diff>");
    expect(toggledIds).toEqual([reviewItem.id]);
  });

  test("exposes accessible status labels for each changed-file status", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const item = new ReviewDiffItem();
    const reviewItem = parsed.items[0]!;

    for (const [status, label] of [
      ["change", "Modified file"],
      ["new", "Added file"],
      ["deleted", "Deleted file"],
      ["rename-pure", "Renamed file"],
      ["rename-changed", "Renamed file"],
    ] as const) {
      item.item = { ...reviewItem, status };
      expect(templateToString(item.render())).toContain(`aria-label="${label}"`);
    }
  });
});
