import { describe, expect, test } from "bun:test";
import "../../helpers/local-storage.js";
import { Loadable } from "../../../helpers/loadable.js";
import {
  ReviewDiffPanel,
  ReviewScrollPosition,
} from "../../../components/changes/review-diff-panel.js";
import { DiffStore, type DiffPatchData } from "../../../models/stores/diff-store.js";
import "../../../components/changes/review-diff-item.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
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

function loadedPatch(patch = PATCH): DiffPatchData {
  return {
    patch,
    cacheKeyPrefix: "project-7-v1",
    version: 1,
    branch: "task/example",
    baseBranch: "master",
  };
}

interface RepeatDirectiveResult {
  _$litDirective$: unknown;
  values: [
    Array<{ id: string }>,
    (item: { id: string }, index: number) => unknown,
    (item: { id: string }, index: number) => unknown,
  ];
}

function isRepeatDirectiveResult(value: unknown): value is RepeatDirectiveResult {
  return typeof value === "object"
    && value !== null
    && "_$litDirective$" in value
    && "values" in value
    && Array.isArray(value.values)
    && value.values.length === 3;
}

function manyFilePatch(count: number): string {
  return Array.from({ length: count }, (_, index) => `diff --git a/src/file-${index}.ts b/src/file-${index}.ts
index 1111111..2222222 100644
--- a/src/file-${index}.ts
+++ b/src/file-${index}.ts
@@ -1 +1 @@
-old-${index}
+new-${index}
`).join("");
}

describe("ReviewDiffPanel", () => {
  test("restores the last measurable scroll position after the hidden pane reports zero", () => {
    const position = new ReviewScrollPosition();
    const container = { scrollTop: 4944, clientHeight: 823 };

    position.remember(container, true);
    container.scrollTop = 0;
    container.clientHeight = 0;
    position.remember(container, false);
    container.scrollTop = 1132;
    container.clientHeight = 823;

    expect(position.restore(container, true)).toBe(true);
    expect(container.scrollTop).toBe(4944);
  });

  test("refreshes a loaded patch when returning to the Changes tab", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
    let fetchCount = 0;
    store.fetchPatchDiff = async () => { fetchCount += 1; };
    const panel = new ReviewDiffPanel();
    panel.store = store;
    panel.visible = true;

    panel.willUpdate(new Map([["visible", false]]));

    expect(fetchCount).toBe(1);
    store.dispose();
  });

  test("restores reviewed collapse state after switching projects", () => {
    localStorage.clear();
    const store = new DiffStore();
    store.refresh = async () => {};
    try {
      store.setProject(7);
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
      const panel = new ReviewDiffPanel();
      panel.store = store;
      const itemId = panel.itemIdForPath("src/example.ts")!;
      panel.setItemCollapsed(itemId, true);

      store.setProject(8);
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded({
        ...loadedPatch(),
        cacheKeyPrefix: "project-8-v1",
      });
      panel.willUpdate(new Map());
      expect(panel.isItemCollapsed(itemId)).toBe(false);

      store.setProject(7);
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
      panel.willUpdate(new Map());
      expect(panel.isItemCollapsed(itemId)).toBe(true);
    } finally {
      localStorage.clear();
      store.dispose();
    }
  });

  test("mounts only the initial viewport and overscan file wrappers for a many-file review", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch(manyFilePatch(100)));
    const panel = new ReviewDiffPanel();
    panel.store = store;

    const renderedPanel = panel.render();
    const directive = collectTemplateValues(renderedPanel).find(isRepeatDirectiveResult);
    if (!directive) throw new Error("Expected virtual review items");
    const [mountedItems, , renderItem] = directive.values;
    const output = templateToString(mountedItems.map(renderItem));

    expect(mountedItems.length).toBeGreaterThan(0);
    expect(mountedItems.length).toBeLessThan(20);
    expect(templateToString(renderedPanel)).toContain("position:relative;height:");
    expect(output).toContain("position:absolute;top:");
    expect(output).toContain("src/file-0.ts");
    expect(output).not.toContain("data-file-path=src/file-99.ts");
    store.dispose();
  });

  test("renders loading, empty, parse-error, and request-error outcomes", () => {
    const store = new DiffStore();
    const panel = new ReviewDiffPanel();

    store.patchData = Loadable.idle<DiffPatchData>().asLoading();
    panel.store = store;
    expect(templateToString(panel.render())).toContain("Loading Reins diff");

    store.patchData = store.patchData.asLoaded(loadedPatch(""));
    panel.store = null;
    panel.store = store;
    expect(templateToString(panel.render())).toContain("No changes yet");

    store.patchData = store.patchData.asLoaded(loadedPatch("diff --git a/a.ts b/a.ts\n@@ invalid\n+x"));
    panel.store = null;
    panel.store = store;
    expect(templateToString(panel.render())).toContain("Unable to parse patch");

    store.patchData = store.patchData.asError("network failed");
    expect(templateToString(panel.render())).toContain("Error: network failed");
    store.dispose();
  });

  test("waits for an in-flight patch refresh before file-tree navigation scrolls", () => {
    const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    const store = new DiffStore();
    try {
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch()).asLoading();
      const panel = new ReviewDiffPanel();
      panel.store = store;
      let scrollCount = 0;
      panel.scrollTo = () => { scrollCount += 1; };
      const querySelector: typeof panel.querySelector = (selector: string) => (
        selector === "[data-review-scroll]" ? panel : null
      );
      panel.querySelector = querySelector;

      panel.scrollToFile("src/example.ts");
      expect(scrollCount).toBe(0);

      store.patchData = store.patchData.asLoaded(loadedPatch());
      panel.willUpdate(new Map());
      panel.updated(new Map());
      frames.shift()?.(0);

      expect(scrollCount).toBe(1);
    } finally {
      store.dispose();
      if (frameDescriptor) Object.defineProperty(globalThis, "requestAnimationFrame", frameDescriptor);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
  });

  test("navigates to an initially unmounted file from virtual layout geometry", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch(manyFilePatch(100)));
    const panel = new ReviewDiffPanel();
    panel.store = store;
    let targetTop: number | undefined;
    panel.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options !== "number") targetTop = options?.top;
    };
    const querySelector: typeof panel.querySelector = (selector: string) => (
      selector === "[data-review-scroll]" ? panel : null
    );
    panel.querySelector = querySelector;

    panel.scrollToFile("src/file-99.ts");

    expect(targetTop).toBeGreaterThan(0);
    store.dispose();
  });

  test("retargets file navigation when measured geometry changes", async () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch(manyFilePatch(100)));
    const panel = new ReviewDiffPanel();
    panel.store = store;
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 300 });
    panel.scrollTop = 0;
    const scrollTargets: number[] = [];
    panel.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options !== "number" && options?.top !== undefined) scrollTargets.push(options.top);
    };
    const querySelector: typeof panel.querySelector = (selector: string) => (
      selector === "[data-review-scroll]" ? panel : null
    );
    panel.querySelector = querySelector;

    panel.scrollToFile("src/file-99.ts");
    const initialTarget = scrollTargets.at(-1);
    const directive = collectTemplateValues(panel.render()).find(isRepeatDirectiveResult);
    if (!directive) throw new Error("Expected virtual review items");
    const firstItem = directive.values[0][0];
    if (!firstItem) throw new Error("Expected a mounted review item");
    const itemTemplate = directive.values[2](firstItem, 0);
    const measurementListener = collectTemplateEventListeners(itemTemplate, "review-item-measurement")[0];

    measurementListener?.call(panel, new CustomEvent("review-item-measurement", {
      detail: { id: firstItem.id, height: 500 },
    }));
    await Promise.resolve();
    panel.updated(new Map());

    expect(initialTarget).toBeGreaterThan(0);
    expect(scrollTargets.at(-1)).toBeGreaterThan(initialTarget!);
    expect(panel.scrollTop).toBe(0);
    store.dispose();
  });

  test("anchors the viewport when a file above it changes collapsed height", () => {
    localStorage.clear();
    const store = new DiffStore();
    store.setProject(7);
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch(manyFilePatch(3)));
    const panel = new ReviewDiffPanel();
    panel.store = store;
    panel.scrollTop = 150;
    const querySelector: typeof panel.querySelector = (selector: string) => (
      selector === "[data-review-scroll]" ? panel : null
    );
    panel.querySelector = querySelector;

    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 100 });
    panel.setItemCollapsed(panel.itemIdForPath("src/file-0.ts")!, true);
    expect(panel.scrollTop).toBe(150);
    panel.updated(new Map());

    expect(panel.scrollTop).toBe(94);
    localStorage.clear();
    store.dispose();
  });

  test("expands a collapsed target before file-tree navigation scrolls to it", () => {
    localStorage.clear();
    const store = new DiffStore();
    store.setProject(7);
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
    const panel = new ReviewDiffPanel();
    panel.store = store;
    const itemId = panel.itemIdForPath("src/example.ts")!;
    panel.setItemCollapsed(itemId, true);
    let scrollCount = 0;
    panel.scrollTo = () => { scrollCount += 1; };
    const querySelector: typeof panel.querySelector = (selector: string) => (
      selector === "[data-review-scroll]" ? panel : null
    );
    panel.querySelector = querySelector;

    panel.scrollToFile("src/example.ts");

    expect(panel.isItemCollapsed(itemId)).toBe(false);
    expect(scrollCount).toBe(1);
    localStorage.clear();
    store.dispose();
  });

  test("reports active review identity and file path through public events", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
    const panel = new ReviewDiffPanel();
    panel.store = store;
    const activeItems: unknown[] = [];
    const activeFiles: unknown[] = [];
    panel.addEventListener("active-item-change", (event) => {
      if (event instanceof CustomEvent) activeItems.push(event.detail);
    });
    panel.addEventListener("active-file-change", (event) => {
      if (event instanceof CustomEvent) activeFiles.push(event.detail);
    });
    const itemId = panel.itemIdForPath("src/example.ts")!;

    panel.reportActiveItem(itemId);
    panel.reportActiveItem(itemId);

    expect(activeItems).toEqual([itemId]);
    expect(activeFiles).toEqual(["src/example.ts"]);
    store.dispose();
  });
});
