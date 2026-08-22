import { afterEach, describe, expect, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { ReviewDiffItem } from "../../../components/changes/review-diff-item.js";
import { SpringCollapseDirective } from "../../../directives/spring-collapse.js";
import { ReviewExpansionState } from "../../../models/changes/review-expansion-state.js";
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

const EXPANDABLE_PATCH = PATCH.replace("@@ -1 +1 @@", "@@ -33 +33 @@");

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
    item.render();
    const requested = Reflect.get(renderer, "requested");
    Reflect.set(renderer, "containerValue", container);
    Reflect.set(renderer, "completed", requested);
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
    item.render();
    Reflect.set(renderer, "completed", Reflect.get(renderer, "requested"));

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

  test("pre-acquires complete content only after a mounted expandable control is relevant", () => {
    const reviewItem = parseReviewItems(EXPANDABLE_PATCH, "project-7-v1").items[0]!;
    const item = new ReviewDiffItem();
    item.item = reviewItem;
    item.expansion = new ReviewExpansionState({ projectId: 7, mode: "branch" }).forItem(reviewItem);
    const acquired: string[] = [];
    item.addEventListener("review-context-acquire", (event) => {
      if (event instanceof CustomEvent) acquired.push(event.detail.id);
    });

    // Constructing/rendering an item does not acquire: only the mounted Pierre
    // control relevance callback crosses the acquisition seam.
    item.render();
    expect(acquired).toEqual([]);
    Reflect.get(item, "_contextControlRelevant").call(item);

    expect(acquired).toEqual([reviewItem.id]);
  });

  test("retains a first-click intent while pre-acquisition is loading", () => {
    const reviewItem = parseReviewItems(EXPANDABLE_PATCH, "project-7-v1").items[0]!;
    const state = new ReviewExpansionState({ projectId: 7, mode: "branch" });
    const item = new ReviewDiffItem();
    const interaction = {
      hunkIndex: 0, direction: "down" as const, anchorTop: 20, anchorLineNumber: 33,
    };
    item.item = reviewItem;
    item.expansion = { ...state.forItem(reviewItem), outcome: "loading" };
    Reflect.get(item, "_diffTarget").call(item, reviewItem);

    Reflect.get(item, "_requestAcquisition").call(item, interaction);
    const completeFileDiff = { ...reviewItem.fileDiff, isPartial: false };
    item.expansion = { ...item.expansion, outcome: "available", fileDiff: completeFileDiff };
    const target = Reflect.get(item, "_diffTarget").call(item, reviewItem);

    expect(target.initialExpansion).toEqual(interaction);
  });

  test("anchors Pierre's from-end expansion to measured item growth", () => {
    const reviewItem = parseReviewItems(PATCH, "project-7-v1").items[0]!;
    const item = new ReviewDiffItem();
    item.item = reviewItem;
    const separator = new ReviewDiffItem();
    const anchoredLine = new ReviewDiffItem();
    separator.getBoundingClientRect = () => ({ ...testRect(0), top: 80, bottom: 80 });
    anchoredLine.getBoundingClientRect = () => ({ ...testRect(0), top: 140, bottom: 140 });
    const root = {
      querySelector(selector: string) {
        if (selector === `[data-expand-index="0"]`) return separator;
        if (selector === `[data-column-number="33"]`) return anchoredLine;
        return null;
      },
    };
    const container = new ReviewDiffItem();
    Object.defineProperty(container, "shadowRoot", { configurable: true, value: root });
    Reflect.set(Reflect.get(item, "_diff"), "containerValue", container);
    Reflect.get(item, "_rememberExpansionAnchor").call(item, {
      hunkIndex: 0,
      direction: "down",
      anchorTop: 100,
      anchorLineNumber: 33,
    });
    const anchors: unknown[] = [];
    item.addEventListener("review-expansion-anchor", (event) => {
      if (event instanceof CustomEvent) anchors.push(event.detail);
    });

    Reflect.get(item, "_reconcileExpansionAnchor").call(item);

    expect(anchors).toEqual([{
      growthItemId: reviewItem.id,
      operationId: expect.stringMatching(/^review-expansion-/),
    }]);
  });

  test("leaves expansion controls to Pierre and reports acquisition failure without replacing the diff", () => {
    const reviewItem = parseReviewItems(PATCH, "project-7-v1").items[0]!;
    const state = new ReviewExpansionState({ projectId: 7, mode: "branch" });
    const item = new ReviewDiffItem();
    item.item = reviewItem;
    item.expansion = {
      ...state.forItem(reviewItem),
      outcome: "error",
      error: "offline",
    };

    const output = renderOutput(item);

    expect(output).toContain("<diffs-container data-pierre-file-diff");
    expect(output).toContain("Unable to load complete file context.");
    expect(output).not.toContain("Expand context");
    expect(output).not.toContain("data-reins-context-control");
    expect(output).not.toContain("Expand trailing unchanged context");
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
