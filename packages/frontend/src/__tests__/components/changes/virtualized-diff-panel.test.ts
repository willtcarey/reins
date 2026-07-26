import { describe, expect, test } from "bun:test";
import { Loadable } from "../../../helpers/loadable.js";
import {
  applyPierreDiffBackground,
  VirtualizedDiffItem,
  VirtualizedDiffPanel,
} from "../../../components/changes/virtualized-diff-panel.js";
import { parseVirtualizedReviewItems } from "../../../models/changes/virtualized-review-items.js";
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

describe("VirtualizedDiffPanel", () => {
  test("mirrors Pierre's resolved background into Reins-owned chrome", () => {
    const properties = new Map<string, string>();
    const source = {
      backgroundColor: "rgb(36, 41, 46)",
      getPropertyValue: (name: string) => name === "--diffs-bg" ? "rgb(13, 17, 23)" : "",
    };
    const target = {
      setProperty: (name: string, value: string) => { properties.set(name, value); },
    };

    expect(applyPierreDiffBackground(source, target)).toBe(true);
    expect(properties.get("--reins-diff-background")).toBe("rgb(13, 17, 23)");
  });

  test("renders a Reins-owned minimum header around the Pierre text-diff host", () => {
    const parsed = parseVirtualizedReviewItems(PATCH, "project-7-v1", 1);
    const item = new VirtualizedDiffItem();
    item.item = parsed.items[0] ?? null;

    const output = templateToString(item.render());

    expect(output).toContain('aria-label="Modified file"');
    expect(output).toContain('class="h-3 w-3 shrink-0 text-sky-400"');
    expect(output).toContain("<svg");
    expect(output).not.toContain(">change<");
    expect(output).toContain("<bdi>src/example.ts</bdi>");
    expect(output).toContain('class="reins-diff-path min-w-0 truncate');
    expect(output).toContain('<header class="reins-diff-header sticky');
    expect(output).toContain("items-center gap-2 px-3 py-2");
    expect(output).not.toContain("items-center gap-2 border-b");
    expect(output).not.toContain("flex-1");
    expect(output).not.toContain("direction-rtl");
    expect(output).toContain("<diffs-container data-pierre-file-diff>");
  });

  test("renders distinct status icons for added, deleted, and renamed files", () => {
    const parsed = parseVirtualizedReviewItems(PATCH, "project-7-v1", 1);
    const item = new VirtualizedDiffItem();
    const reviewItem = parsed.items[0]!;

    item.item = { ...reviewItem, status: "new" };
    expect(templateToString(item.render())).toContain('aria-label="Added file"');

    item.item = { ...reviewItem, status: "deleted" };
    expect(templateToString(item.render())).toContain('aria-label="Deleted file"');

    item.item = { ...reviewItem, status: "rename-changed" };
    expect(templateToString(item.render())).toContain('aria-label="Renamed file"');
  });

  test("shows a file-scoped worker highlighting error without replacing the diff", () => {
    const parsed = parseVirtualizedReviewItems(PATCH, "project-7-v1", 1);
    const item = new VirtualizedDiffItem();
    item.item = parsed.items[0] ?? null;

    item.reportHighlightError(new Error("TypeScript grammar failed to load"));
    const output = templateToString(item.render());

    expect(output).toContain("Syntax highlighting failed");
    expect(output).toContain("TypeScript grammar failed to load");
    expect(output).toContain("<diffs-container data-pierre-file-diff>");
  });

  test("renders the raw patch as a non-virtual Reins-owned item list", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded({
      patch: PATCH,
      cacheKeyPrefix: "project-7-v1",
      version: 1,
      branch: "task/example",
      baseBranch: "master",
    });
    const panel = new VirtualizedDiffPanel();
    panel.store = store;

    const output = templateToString(panel.render());

    expect(output).toContain("Reins diff scaffold");
    expect(output).toContain("non-virtual");
    expect(output).toContain("<virtualized-diff-item");
    expect(panel.itemIdForPath("src/example.ts")).toBe("review:change::src%2Fexample.ts:0");
    store.dispose();
  });

  test("reports active item identity and the file path expected by the shell", () => {
    const store = new DiffStore();
    store.patchData = Loadable.idle<DiffPatchData>().asLoaded({
      patch: PATCH,
      cacheKeyPrefix: "project-7-v1",
      version: 1,
      branch: "task/example",
      baseBranch: "master",
    });
    const panel = new VirtualizedDiffPanel();
    panel.store = store;
    const activeItems: unknown[] = [];
    const activeFiles: unknown[] = [];
    panel.addEventListener("active-item-change", (event) => {
      if (event instanceof CustomEvent) activeItems.push(event.detail);
    });
    panel.addEventListener("active-file-change", (event) => {
      if (event instanceof CustomEvent) activeFiles.push(event.detail);
    });

    panel.reportActiveItem(panel.itemIdForPath("src/example.ts")!);

    expect(activeItems).toEqual(["review:change::src%2Fexample.ts:0"]);
    expect(activeFiles).toEqual(["src/example.ts"]);
    store.dispose();
  });
});
