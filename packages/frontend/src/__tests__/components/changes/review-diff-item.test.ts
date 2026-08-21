import { afterEach, describe, expect, test } from "bun:test";
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

function testRect(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
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
  const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");

  afterEach(() => {
    if (resizeObserverDescriptor) Object.defineProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  test("observes its own height and emits only a narrow stable measurement", () => {
    let notifyResize: (() => void) | undefined;
    const observed: Element[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this);
      }
      observe(target: Element) { observed.push(target); }
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });

    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const reviewItem = parsed.items[0]!;
    const item = new ReviewDiffItem();
    const article = new ReviewDiffItem();
    const container = new ReviewDiffItem();
    const pre = new ReviewDiffItem();
    let placeholder = true;
    item.item = reviewItem;
    item.reservedHeight = 240;
    Object.defineProperty(article, "isConnected", { configurable: true, value: true });
    item.getBoundingClientRect = () => testRect(137);
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    Object.defineProperty(container, "shadowRoot", {
      configurable: true,
      value: {
        querySelector: (selector: string) => {
          if (selector === "pre") return pre;
          if (selector === "[data-placeholder]") return placeholder ? pre : null;
          return null;
        },
      },
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
    const measurements: unknown[] = [];
    item.addEventListener("review-item-measurement", (event) => measurements.push(event.detail));

    item.updated();
    notifyResize?.();
    expect(measurements).toEqual([]);

    placeholder = false;
    notifyResize?.();

    expect(observed).toEqual([item]);
    expect(measurements).toEqual([{ id: reviewItem.id, height: 137 }]);
    expect(renderOutput(item)).not.toContain("min-height:240px");
  });

  test("does not emit for stale completion after Lit removes the current structure", () => {
    const parsed = parseReviewItems(PATCH, "project-7-v1");
    const reviewItem = parsed.items[0]!;
    const item = new ReviewDiffItem();
    item.item = reviewItem;
    item.reservedHeight = 240;
    item.getBoundingClientRect = () => testRect(137);
    Object.defineProperty(item, "isConnected", { configurable: true, value: true });
    const renderer: object = Reflect.get(item, "_diff");
    Reflect.set(renderer, "requested", reviewItem.fileDiff);
    Reflect.set(renderer, "completed", reviewItem.fileDiff);

    const measurements: unknown[] = [];
    item.addEventListener("review-item-measurement", (event) => measurements.push(event.detail));
    item.updated();

    expect(item.diffRendered).toBe(false);
    expect(measurements).toEqual([]);
    expect(renderOutput(item)).toContain("min-height:240px");
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
