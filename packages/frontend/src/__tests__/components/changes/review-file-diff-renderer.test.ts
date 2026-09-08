import { describe, expect, test } from "bun:test";
import {
  FileDiff,
  processFile,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import { ReviewCommentThread } from "../../../components/changes/review-comment-thread.js";
import {
  createReviewFileDiffRenderer,
  type ReviewFileDiffTarget,
} from "../../../components/changes/review-file-diff-renderer.js";

function host(): ReactiveControllerHost {
  return { addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) };
}

function partialDiff(): FileDiffMetadata {
  const fileDiff = processFile(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -4,4 +4,4 @@
 one
 two
-old
+new
 four
`);
  if (!fileDiff) throw new Error("Expected parsed diff");
  return fileDiff;
}

describe("ReviewFileDiffRenderer", () => {
  test("wires lazy loading and expansion anchoring into Pierre", async () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = FileDiff.prototype.render;
    const root = {
      replaceChildren() {},
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    class TestHTMLElement extends EventTarget {
      shadowRoot = root;
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });
    const renderedMetadata: FileDiffMetadata[] = [];
    Reflect.set(FileDiff.prototype, "render", function render(
      this: FileDiff,
      props?: { fileDiff?: FileDiffMetadata; containerWrapper?: HTMLElement },
    ) {
      if (props?.fileDiff) {
        this.fileDiff = props.fileDiff;
        renderedMetadata.push(props.fileDiff);
      }
      if (props?.containerWrapper) {
        this.options.onPostRender?.(props.containerWrapper, this, "mount");
      }
      return true;
    });

    try {
      const fileDiff = partialDiff();
      let loads = 0;
      const interactions: Array<{ hunkIndex: number; direction: string }> = [];
      const controller = createReviewFileDiffRenderer(
        host(),
        undefined,
        (interaction, mutate) => {
          interactions.push(interaction);
          mutate();
        },
        undefined,
        null,
      );
      const target: ReviewFileDiffTarget = {
        fileDiff,
        loadDiffFiles: async () => {
          loads += 1;
          return {
            oldFile: { name: "file.txt", contents: "zero\none\ntwo\nold\nfour\n" },
            newFile: { name: "file.txt", contents: "zero\none\ntwo\nnew\nfour\n" },
          };
        },
        expansionHistory: [],
      };
      const bindingValues = Reflect.get(controller.bind(target), "values");
      const attach = Array.isArray(bindingValues) ? bindingValues[0] : null;
      if (typeof attach !== "function") throw new Error("Expected renderer ref binding");
      attach(new TestHTMLElement());

      const instance = controller.instance;
      if (!instance) throw new Error("Expected FileDiff instance");
      expect(instance.options.loadDiffFiles).toBeFunction();
      expect(loads).toBe(0);

      Reflect.set(instance, "primeHighlightCache", async () => {});
      instance.handleExpandHunk(0, "down");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(interactions).toHaveLength(1);
      expect(interactions[0]).toMatchObject({ hunkIndex: 0, direction: "down" });
      expect(loads).toBe(1);
      expect(renderedMetadata[0]).toBe(fileDiff);

      const remountedDiff = partialDiff();
      let remountLoads = 0;
      const remounted = createReviewFileDiffRenderer(host(), undefined, undefined, undefined, null);
      const remountBinding = Reflect.get(remounted.bind({
        fileDiff: remountedDiff,
        loadDiffFiles: async () => {
          remountLoads += 1;
          return {
            oldFile: { name: "file.txt", contents: "zero\none\ntwo\nold\nfour\n" },
            newFile: { name: "file.txt", contents: "zero\none\ntwo\nnew\nfour\n" },
          };
        },
        expansionHistory: [{ hunkIndex: 0, direction: "down", lineCount: 15 }],
      }), "values");
      const attachRemount = Array.isArray(remountBinding) ? remountBinding[0] : null;
      if (typeof attachRemount !== "function") throw new Error("Expected remount binding");
      attachRemount(new TestHTMLElement());
      if (!remounted.instance) throw new Error("Expected remounted FileDiff");
      Reflect.set(remounted.instance, "primeHighlightCache", async () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(remountLoads).toBe(1);
    } finally {
      Reflect.set(FileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("nests an unmanaged diff and adapts public selection and annotation hooks", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = FileDiff.prototype.render;
    const gutterUtility = { hidden: false };
    const root = {
      replaceChildren() {}, addEventListener() {}, querySelector() { return null; },
      querySelectorAll(selector: string) { return selector === "[data-gutter-utility-slot]" ? [gutterUtility] : []; },
    };
    class TestHTMLElement extends EventTarget {
      shadowRoot = root;
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });
    let renderProps: Record<string, unknown> | null = null;
    Reflect.set(FileDiff.prototype, "render", function render(props: Record<string, unknown>) {
      renderProps = props;
      return true;
    });

    try {
      const observed: {
        selection: { side: "old" | "new"; startLine: number; endLine: number } | null;
        error: string | null;
      } = { selection: null, error: null };
      const target: ReviewFileDiffTarget = {
        fileDiff: partialDiff(),
        loadDiffFiles: async () => { throw new Error("not requested"); },
        expansionHistory: [],
        inlineReview: {
          placements: [], selection: null, error: null, threadCount: 0, layoutRevision: 0,
          select: (range) => { observed.selection = range; },
          openComposer: (range) => { observed.selection = range; },
          reportError: (message) => { observed.error = message; },
        },
      };
      const controller = createReviewFileDiffRenderer(host(), undefined, undefined, undefined, null);
      const bindingValues = Reflect.get(controller.bind(target), "values");
      const attach = Array.isArray(bindingValues) ? bindingValues[0] : null;
      if (typeof attach !== "function") throw new Error("Expected renderer ref binding");
      const mount = new TestHTMLElement();
      attach(mount);
      const instance = controller.instance;
      if (!instance) throw new Error("Expected renderer instance");

      instance.options.onLineSelected?.({ start: 7, end: 4, side: "additions", endSide: "additions" });
      expect(observed.selection).toEqual({ side: "new", startLine: 4, endLine: 7 });
      instance.options.onGutterUtilityClick?.({ start: 4, end: 7, side: "deletions", endSide: "additions" });
      expect(observed.error).toBe("Inline comments must stay on one side of the diff.");

      target.inlineReview = {
        ...target.inlineReview!,
        placements: [{
          id: "file-a:new:7",
          range: { side: "new", startLine: 4, endLine: 7 },
          comments: [], deletingCommentId: null, deleteComment: async () => {}, addComment: () => {},
          composer: null,
        }],
        selection: { side: "new", startLine: 4, endLine: 7 },
      };
      let annotations: Parameters<typeof instance.setLineAnnotations>[0] = [];
      const selections: Array<SelectedLineRange | null> = [];
      instance.setLineAnnotations = (value) => { annotations = value; };
      instance.setSelectedLines = (value) => { selections.push(value); };
      instance.rerender = () => {};
      controller.refreshInlineComments();

      expect(renderProps).toMatchObject({ containerWrapper: mount });
      expect(annotations).toEqual([{ side: "additions", lineNumber: 7, metadata: "file-a:new:7" }]);
      expect(selections).toEqual([{ start: 4, end: 7, side: "additions", endSide: "additions" }]);
      const annotation = annotations[0];
      if (!annotation) throw new Error("Expected annotation");
      expect(instance.options.renderAnnotation?.(annotation)).toBeInstanceOf(ReviewCommentThread);
    } finally {
      Reflect.set(FileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });
});
