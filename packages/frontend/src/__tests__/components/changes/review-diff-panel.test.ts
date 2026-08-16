import { describe, expect, test } from "bun:test";
import { Loadable } from "../../../helpers/loadable.js";
import {
  ReviewDiffItem,
  ReviewDiffPanel,
  ReviewScrollPosition,
} from "../../../components/changes/review-diff-panel.js";
import { parseReviewItems } from "../../../models/changes/review-items.js";
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

  test("reuses its Pierre renderer when a mounted review item receives fresh metadata", () => {
    const first = parseReviewItems(PATCH, "project-7-v1").items[0]!;
    const second = parseReviewItems(PATCH, "project-7-v2").items[0]!;
    const renders: unknown[] = [];
    let factoryCalls = 0;
    let cleanups = 0;
    class MountedReviewDiffItem extends ReviewDiffItem {
      protected override getDiffRoot(): HTMLElement {
        return this;
      }
    }
    const component = new MountedReviewDiffItem(() => {
      factoryCalls += 1;
      return {
        render: (props) => {
          renders.push(props.fileDiff);
          return true;
        },
        cleanUp: () => { cleanups += 1; },
      };
    });

    component.item = first;
    component.updated();
    component.item = second;
    component.updated();

    expect(factoryCalls).toBe(1);
    expect(cleanups).toBe(0);
    expect(renders).toEqual([first.fileDiff, second.fileDiff]);
  });

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
