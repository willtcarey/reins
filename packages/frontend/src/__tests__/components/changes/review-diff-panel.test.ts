import { describe, expect, test } from "bun:test";
import "../../helpers/local-storage.js";
import { Loadable } from "../../../helpers/loadable.js";
import {
  ReviewDiffPanel,
  ReviewScrollPosition,
} from "../../../components/changes/review-diff-panel.js";
import { DiffStore, type DiffPatchData } from "../../../models/stores/diff-store.js";
import { templateToString } from "../../helpers/lit-template.js";

const PATCH = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new
`;

function rectAt(top: number): DOMRect {
  return {
    bottom: top,
    height: 0,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function loadedPatch(patch = PATCH): DiffPatchData {
  return {
    patch,
    cacheKeyPrefix: "project-7-v1",
    version: 1,
    branch: "task/example",
    baseBranch: "master",
  };
}


describe("ReviewDiffPanel", () => {
  test("registers its review item dependency", () => {
    const ReviewDiffItemElement = customElements.get("review-diff-item");

    expect(typeof Reflect.get(ReviewDiffItemElement?.prototype ?? {}, "render")).toBe("function");
  });

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

  test("turns a loaded patch into stable path-based navigation", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
    const panel = new ReviewDiffPanel();
    panel.store = store;

    const itemId = panel.itemIdForPath("src/example.ts");
    const output = templateToString(panel.render());

    expect(itemId).toBe("review:change::src%2Fexample.ts:0");
    expect(output).toContain("data-rendered-payload-version=1");
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

  test("animates file-tree navigation after the target layout is ready", () => {
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
    const store = new DiffStore();
    try {
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch());
      const panel = new ReviewDiffPanel();
      panel.store = store;
      let behavior: ScrollBehavior | undefined;
      panel.getBoundingClientRect = () => rectAt(0);
      panel.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options !== "number") behavior = options?.behavior;
      };
      const querySelector: typeof panel.querySelector = () => panel;
      panel.querySelector = querySelector;

      panel.scrollToFile("src/example.ts");

      expect(behavior).toBe("smooth");
    } finally {
      store.dispose();
      if (cssDescriptor) Object.defineProperty(globalThis, "CSS", cssDescriptor);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });

  test("waits for an in-flight patch refresh before file-tree navigation scrolls", () => {
    const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });

    const store = new DiffStore();
    try {
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch()).asLoading();
      const panel = new ReviewDiffPanel();
      panel.store = store;
      let scrollCount = 0;
      panel.scrollIntoView = () => { scrollCount += 1; };
      const querySelector: typeof panel.querySelector = (selector: string) => (
        selector.startsWith("[data-review-item-id=") ? panel : null
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
      if (cssDescriptor) Object.defineProperty(globalThis, "CSS", cssDescriptor);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });

  test("waits for preceding diff bodies to render before scrolling to a file", () => {
    const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
    const patch = `${PATCH}diff --git a/src/target.ts b/src/target.ts
index 3333333..4444444 100644
--- a/src/target.ts
+++ b/src/target.ts
@@ -1 +1 @@
-before
+after
`;
    const store = new DiffStore();
    try {
      store.patchData = Loadable.idle<DiffPatchData>().asLoaded(loadedPatch(patch));
      const panel = new ReviewDiffPanel();
      panel.store = store;
      const precedingId = panel.itemIdForPath("src/example.ts")!;
      let precedingRendered = false;
      const ReviewDiffItemElement = customElements.get("review-diff-item");
      if (!ReviewDiffItemElement) throw new Error("Expected review-diff-item to be registered");
      const precedingItem = new ReviewDiffItemElement();
      Object.defineProperty(precedingItem, "diffRendered", {
        get: () => precedingRendered,
      });
      let targetQueries = 0;
      const querySelector: typeof panel.querySelector = (selector: string) => {
        if (selector.includes(precedingId)) return precedingItem;
        targetQueries += 1;
        return null;
      };
      panel.querySelector = querySelector;

      panel.scrollToFile("src/target.ts");
      expect(targetQueries).toBe(0);

      precedingRendered = true;
      panel.updated(new Map());
      frames.shift()?.(0);

      expect(targetQueries).toBeGreaterThan(0);
    } finally {
      store.dispose();
      if (frameDescriptor) Object.defineProperty(globalThis, "requestAnimationFrame", frameDescriptor);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      if (cssDescriptor) Object.defineProperty(globalThis, "CSS", cssDescriptor);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
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
    let queryCount = 0;
    const querySelector: typeof panel.querySelector = () => {
      queryCount += 1;
      return null;
    };
    panel.querySelector = querySelector;

    panel.scrollToFile("src/example.ts");

    expect(panel.isItemCollapsed(itemId)).toBe(false);
    expect(queryCount).toBe(0);
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
