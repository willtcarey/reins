import { describe, expect, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { ReviewDiffItem } from "../../../components/changes/review-diff-item.js";
import { SpringCollapseDirective } from "../../../directives/spring-collapse.js";
import { parseReviewItems } from "../../../models/changes/review-items.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
  templateToString,
} from "../../helpers/lit-template.js";

interface DirectiveResult {
  _$litDirective$: typeof SpringCollapseDirective;
  values: Parameters<SpringCollapseDirective["render"]>;
}

function renderOutput(item: ReviewDiffItem): string {
  const template = item.render();
  const collapse = collectTemplateValues(template).find((value): value is DirectiveResult => (
    typeof value === "object"
      && value !== null
      && "_$litDirective$" in value
      && value._$litDirective$ === SpringCollapseDirective
  ));
  if (!collapse) return templateToString(template);

  const childPart: PartInfo = { type: PartType.CHILD };
  const directive = new SpringCollapseDirective(childPart);
  return templateToString(template) + templateToString(directive.render(...collapse.values));
}

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

    const output = renderOutput(item);

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
    expect(output).toContain("<diffs-container data-pierre-file-diff");
  });

  test("reports pending render state while reserving estimated geometry", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const item = new ReviewDiffItem();
    item.item = parsed.items[0] ?? null;
    item.reservedHeight = 240;

    expect(item.diffRendered).toBe(false);
    expect(renderOutput(item)).toContain("min-height:240px");
  });

  test("accepts a complete render only while its current Pierre structure is mounted", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const reviewItem = parsed.items[0]!;
    const item = new ReviewDiffItem();
    const article = new ReviewDiffItem();
    const container = new ReviewDiffItem();
    const pre = new ReviewDiffItem();
    item.item = reviewItem;
    item.reservedHeight = 240;
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    Object.defineProperty(container, "shadowRoot", {
      configurable: true,
      value: { querySelector: (selector: string) => selector === "pre" ? pre : null },
    });
    const querySelector: typeof item.querySelector = (selector: string) => {
      if (selector === "article") return article;
      if (selector === "[data-pierre-file-diff]") return container;
      return null;
    };
    item.querySelector = querySelector;
    const renderer: object = Reflect.get(item, "_diff");
    Reflect.set(renderer, "containerValue", container);
    Reflect.set(renderer, "requested", reviewItem.fileDiff);
    Reflect.set(renderer, "completed", reviewItem.fileDiff);

    expect(item.diffRendered).toBe(true);
    expect(item.measurementStable).toBe(true);
    expect(renderOutput(item)).not.toContain("min-height:240px");
  });

  test("rejects stale completion after Lit has removed the rendered structure", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const reviewItem = parsed.items[0]!;
    const item = new ReviewDiffItem();
    item.item = reviewItem;
    item.reservedHeight = 240;
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    const renderer: object = Reflect.get(item, "_diff");
    Reflect.set(renderer, "requested", reviewItem.fileDiff);
    Reflect.set(renderer, "completed", reviewItem.fileDiff);

    expect(item.diffRendered).toBe(false);
    expect(item.measurementStable).toBe(false);
    expect(renderOutput(item)).toContain("min-height:240px");
  });

  test("does not animate asynchronous diff rendering as a user expansion", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const item = new ReviewDiffItem();
    item.item = parsed.items[0] ?? null;

    const collapse = collectTemplateValues(item.render()).find((value): value is DirectiveResult => (
      typeof value === "object"
        && value !== null
        && "_$litDirective$" in value
        && value._$litDirective$ === SpringCollapseDirective
    ));

    expect(collapse?.values[2]).toMatchObject({ animateContentResize: false });
  });

  test("renders an accessible collapse control and hides only the diff body when collapsed", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const reviewItem = parsed.items[0]!;
    const item = new ReviewDiffItem();
    item.item = reviewItem;
    item.collapsed = true;
    const toggledIds: string[] = [];
    item.addEventListener("toggle-collapse", (event) => {
      if (event instanceof CustomEvent) toggledIds.push(event.detail);
    });

    const rendered = item.render();
    const output = renderOutput(item);
    collectTemplateEventListeners(rendered, "click")[0]?.call(item, new Event("click"));

    expect(output).toContain(`<button`);
    expect(output).toContain(`aria-label=Expand src/example.ts`);
    expect(output).toContain(`aria-expanded=false`);
    expect(output).toContain("src/example.ts");
    expect(output).not.toContain("<diffs-container data-pierre-file-diff");
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
