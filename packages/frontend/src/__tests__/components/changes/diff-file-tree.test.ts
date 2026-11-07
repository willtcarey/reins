import { afterEach, describe, expect, test } from "bun:test";
import type { Source, View } from "@reins/sdk";
import { DiffFileTree, registerDiffFileTree } from "../../../components/changes/diff-file-tree.js";
import { AppStore } from "../../../models/stores/app-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { paneContext, shownNewSession, shownSession, testSdk } from "../../helpers/reins-sdk.js";
import { StubClient } from "../../helpers/stub-client.js";
import { testElement } from "../../helpers/test-dom.js";
import { Loadable } from "../../../helpers/loadable.js";
import type { DiffFileResponse } from "@backend/routes/diff.js";
import { CodeReviewStore } from "../../../models/stores/code-review-store.js";
import { DiffStore } from "../../../models/stores/diff-store.js";
import {
  collectTemplateEventListeners,
  collectTemplateProperties,
  isTemplateResult,
  templateToString,
} from "../../helpers/lit-template.js";

function renderedNodeTrailer(template: unknown, path: string): string {
  if (!isTemplateResult(template)) throw new Error("Expected rendered file tree");
  const index = template.strings.findIndex((part) => part.trimEnd().endsWith(".renderNodeTrailer="));
  if (index >= 0) {
    const trailer = template.values[index];
    if (typeof trailer !== "function") throw new Error("Expected node trailer renderer");
    return templateToString(trailer({ name: path.split("/").at(-1)!, path, type: "file" }));
  }
  for (const value of template.values) {
    if (isTemplateResult(value)) {
      const output = renderedNodeTrailer(value, path);
      if (output) return output;
    }
  }
  return "";
}

describe("DiffFileTree", () => {
  test("shows the active review comment count beside each changed file", () => {
    const el = new DiffFileTree();
    const store = new DiffStore();
    store.fileData = Loadable.idle<DiffFileResponse>().asLoaded({
      branch: "feature/review",
      baseBranch: "master",
      files: [
        { path: "src/commented.ts", additions: 1, removals: 0 },
        { path: "src/plain.ts", additions: 1, removals: 0 },
      ],
    });
    const reviewStore = new CodeReviewStore();
    reviewStore.review = {
      id: "review-1",
      projectId: 7,
      taskId: 11,
      revision: 1,
      annotations: [{
        id: "annotation-1",
        anchor: {
          path: "src/commented.ts", oldPath: null, side: "new", startLine: 1,
          lines: [{ kind: "addition", text: "new" }], fileFingerprint: null,
          filePatch: "diff --git a/src/commented.ts b/src/commented.ts\n",
          baseRevision: null, headRevision: null,
        },
        entries: [
          { id: "entry-1", author: "You", body: "First", createdAt: "now" },
          { id: "entry-2", author: "Agent", body: "Second", createdAt: "later" },
        ],
      }],
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    };
    el.store = store;
    el.reviewStore = reviewStore;

    const rendered = el.render();

    expect(renderedNodeTrailer(rendered, "src/commented.ts")).toContain("2 review comments");
    expect(renderedNodeTrailer(rendered, "src/plain.ts")).not.toContain("review comments");
    store.dispose();
  });

  test("highlights the file it is given", () => {
    const el = new DiffFileTree();
    const store = new DiffStore();
    store.fileData = Loadable.idle<DiffFileResponse>().asLoaded({
      branch: "feature/review",
      baseBranch: "master",
      files: [{ path: "src/file.ts", additions: 1, removals: 0 }],
    });
    el.store = store;
    el.activeFile = "src/file.ts";

    expect(collectTemplateProperties(el.render(), "activeFile")).toEqual(["src/file.ts"]);
    store.dispose();
  });

  test("emits file-select when the rendered tree-view reports a file click", () => {
    const el = new DiffFileTree();
    const store = new DiffStore();
    store.fileData = Loadable.idle<DiffFileResponse>().asLoaded({
      branch: "feature/mobile-nav",
      baseBranch: "master",
      files: [{ path: "src/file.ts", additions: 1, removals: 0 }],
    });
    el.store = store;
    const selected: Array<{ path: string; bubbles: boolean; composed: boolean }> = [];

    el.addEventListener("file-select", (event) => {
      if (event instanceof CustomEvent) {
        selected.push({
          path: event.detail,
          bubbles: event.bubbles,
          composed: event.composed,
        });
      }
    });

    const [fileClick] = collectTemplateEventListeners(el.render(), "tree-file-click");
    expect(fileClick).toBeDefined();
    fileClick.call(el, new CustomEvent("tree-file-click", { detail: "src/file.ts" }));

    expect(selected).toEqual([{ path: "src/file.ts", bubbles: true, composed: true }]);
  });
});

describe("the diff-file-tree view", () => {
  afterEach(() => restoreFetch());

  const checkout: Source = { nodeId: "internal", path: "/work/project" };
  const changesView: View = { view: "diff-file-tree" };

  /** The tree mounted in the Inspector, beside a main area that shows what a test says, over the app's sessions' diffs. */
  function mountedTree() {
    mockFetch(() => Response.json({ files: [], branch: null, baseBranch: null }));
    const sdk = testSdk();
    const app = new AppStore(new StubClient());
    app.sessionCache.set("s1", { projectId: null, taskId: null, createdAt: "", updatedAt: "", messageCount: 0, state: { model: null, thinkingLevel: "off" }, placement: { available: true, removed: false, nodeId: checkout.nodeId, nodeName: "Internal", path: checkout.path } });
    registerDiffFileTree(sdk.reins.views, sdk.reins.workspace, app.diffs);
    const target = testElement();
    const mounted = sdk.views.rendererFor(changesView)?.pane?.mount(target, changesView, paneContext("inspector")) ?? undefined;
    const tree = target.childNodes[0];
    if (!(tree instanceof DiffFileTree)) throw new Error("Expected the changed-files tree");
    /** The diff of `sessionId` the app has now (a new entry when none uses it). */
    const diffOf = (sessionId: string) => {
      const { diff, release } = app.diffs.use(sessionId);
      release();
      return diff;
    };
    return { ...sdk, app, tree, mounted, diffOf };
  }

  test("shows the diff of the session the main area is about, and follows it to another or to none", () => {
    const { tree, showMain, diffOf } = mountedTree();
    expect(tree.store).toBeNull();

    showMain(shownSession("s1"));
    const first = diffOf("s1");
    expect(tree.store).toBe(first.files);
    expect(tree.reviewStore).toBe(first.review);

    showMain(shownSession("s2"));
    expect(tree.store).toBe(diffOf("s2").files);
    expect(diffOf("s1")).not.toBe(first);

    showMain(shownNewSession(7));
    expect(tree.store).toBeNull();
  });

  test("highlights the file the main area is about when it is in the session's checkout", () => {
    const { tree, showMain } = mountedTree();
    const about = (source: Source) => showMain({
      view: { view: "session-changes", sessionId: "s1" },
      subject: [{ type: "file", id: { source, path: "src/a.ts" } }, { type: "session", id: "s1" }],
    });

    about(checkout);
    expect(tree.activeFile).toBe("src/a.ts");

    about({ nodeId: "internal", path: "/work/other" });
    expect(tree.activeFile).toBeNull();
  });

  test("opens the session's Changes at a file chosen in it, in place of the view shown", () => {
    const { tree, showMain, mainHistory } = mountedTree();
    showMain(shownSession("s1"));

    tree.dispatchEvent(new CustomEvent("file-select", { detail: "src/a.ts" }));

    expect(mainHistory.at(-1)).toBe("#/session/s1/changes?file=src%2Fa.ts");
  });

  test("lets the session's diff go when it is disposed", () => {
    const { mounted, showMain, diffOf } = mountedTree();
    showMain(shownSession("s1"));
    const shown = diffOf("s1");

    mounted?.dispose?.();

    expect(diffOf("s1")).not.toBe(shown);
  });
});
