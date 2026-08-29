import { describe, expect, test } from "bun:test";
import {
  parseDiffFromFile,
  processFile,
  type ExpansionDirections,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import { InlineReviewCommentPlacementElement } from "../../../components/changes/inline-review-comment-placement.js";
import {
  createReviewFileDiffRenderer,
  PierreReviewFileDiff,
} from "../../../components/changes/review-file-diff-renderer.js";
import { InlineReviewComments } from "../../../models/changes/inline-review-comments.js";

function interactionEvent(type: string, path: EventTarget[], properties: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "composedPath", { value: () => path });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

describe("PierreReviewFileDiff", () => {
  test("renders a visible partial acquisition button without loading until activation", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = PierreReviewFileDiff.prototype.render;
    const listeners = new Map<string, EventListener>();
    const queryResults = new Map<string, EventTarget[]>();
    const root = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") listeners.set(type, listener);
      },
      removeEventListener(type: string) { listeners.delete(type); },
      querySelector(selector: string) { return queryResults.get(selector)?.[0] ?? null; },
      querySelectorAll(selector: string) { return queryResults.get(selector) ?? []; },
      replaceChildren() {},
    };
    class TestHTMLElement extends EventTarget {
      shadowRoot = root;
      dataset: Record<string, string> = {};
      nextElementSibling: TestHTMLElement | null = null;
      insertedBefore: TestHTMLElement | null = null;
      children: TestHTMLElement[] = [];
      style = { borderTopLeftRadius: "", borderBottomLeftRadius: "" };
      tabIndex = -1;
      private readonly attributes = new Map<string, string>();
      readonly ownerDocument = {
        createElement: () => new TestHTMLElement(),
        createElementNS: () => new TestHTMLElement(),
      };
      constructor(attributes: string[] = []) {
        super();
        for (const attribute of attributes) this.attributes.set(attribute, "");
      }
      hasAttribute(name: string) { return this.attributes.has(name); }
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
      getAttribute(name: string) { return this.attributes.get(name) ?? null; }
      appendChild(child: TestHTMLElement) { this.children.push(child); return child; }
      before(element: TestHTMLElement) { this.insertedBefore = element; }
      closest: () => TestHTMLElement | null = () => null;
      getBoundingClientRect() { return { top: 20 }; }
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });

    const partial = processFile(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -33 +33 @@
-old
+new
`);
    if (!partial) throw new Error("Expected parsed partial diff");
    const separator = new TestHTMLElement(["data-separator"]);
    const nextLine = new TestHTMLElement();
    nextLine.dataset.lineIndex = `${partial.hunks[0]?.unifiedLineStart},${partial.hunks[0]?.splitLineStart}`;
    separator.nextElementSibling = nextLine;
    const control = new TestHTMLElement(["data-separator-content"]);
    control.closest = () => separator;
    const controlText = new TestHTMLElement(["data-unmodified-lines"]);
    controlText.closest = () => separator;
    queryResults.set("[data-separator-content]", [control]);
    queryResults.set('[data-expand-index="0"]', [separator]);
    const unchanged = Array.from({ length: 32 }, (_, index) => `line ${index + 1}`).join("\n");
    const complete = parseDiffFromFile(
      { name: "file.txt", contents: `${unchanged}\nold\n` },
      { name: "file.txt", contents: `${unchanged}\nnew\n` },
    );
    const renderedMetadata: FileDiffMetadata[] = [];
    const expanded: Array<[number, ExpansionDirections, number | undefined]> = [];
    Reflect.set(PierreReviewFileDiff.prototype, "render", function render(
      this: PierreReviewFileDiff,
      props: { fileDiff: FileDiffMetadata; containerWrapper: HTMLElement },
    ) {
      renderedMetadata.push(props.fileDiff);
      this.options.onPostRender?.(props.containerWrapper, this, "mount");
      return true;
    });
    try {
      const host: ReactiveControllerHost = {
        addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true),
      };
      const acquisitions: number[] = [];
      const nativeInteractions: number[] = [];
      const anchorResolvers: Array<() => number | null> = [];
      const controller = createReviewFileDiffRenderer(
        host,
        undefined,
        (interaction) => acquisitions.push(interaction.hunkIndex),
        (interaction, mutate, anchor) => {
          nativeInteractions.push(interaction.hunkIndex);
          anchorResolvers.push(anchor);
          mutate();
        },
        undefined,
        null,
      );
      const bindingValues = Reflect.get(controller.bind({
        fileDiff: partial,
        nativeExpandedHunks: new Map(),
        initialExpansion: null,
      }), "values");
      const attach = Array.isArray(bindingValues) ? bindingValues[0] : null;
      if (typeof attach !== "function") throw new Error("Expected renderer ref binding");
      attach(new TestHTMLElement());

      expect(acquisitions).toEqual([]);

      const acquisitionButton = control.insertedBefore;
      if (!acquisitionButton) throw new Error("Expected visible acquisition button");
      acquisitionButton.closest = () => separator;
      const partialEvent = interactionEvent("click", [acquisitionButton, separator]);
      listeners.get("click")?.(partialEvent);

      expect(renderedMetadata[0]).toBe(partial);
      expect(renderedMetadata[0]?.isPartial).toBe(true);
      expect(control.getAttribute("role")).toBe("button");
      expect(control.getAttribute("aria-label")).toBe("Expand unchanged lines");
      expect(acquisitionButton.getAttribute("aria-label")).toBe("Expand unchanged lines above");
      expect(acquisitions).toEqual([0]);
      expect(expanded).toEqual([]);

      controller.bind({ fileDiff: complete, nativeExpandedHunks: new Map(), initialExpansion: null });
      controller.hostUpdated();
      if (!controller.instance) throw new Error("Expected complete renderer");
      controller.instance.expandHunk = (hunkIndex, direction, lineCount) => {
        expanded.push([hunkIndex, direction, lineCount]);
      };
      const nativeControl = new TestHTMLElement(["data-expand-button", "data-expand-down"]);
      nativeControl.closest = () => separator;
      separator.dataset.expandIndex = "0";
      const completeEvent = interactionEvent("keydown", [nativeControl, separator], { key: "Enter" });
      listeners.get("keydown")?.(completeEvent);

      expect(nativeInteractions).toEqual([0]);
      expect(expanded).toEqual([[0, "down", undefined]]);
      expect(anchorResolvers[0]?.()).toBe(20);
      expect(completeEvent.defaultPrevented).toBe(true);

      const nativeControlText = new TestHTMLElement(["data-unmodified-lines"]);
      nativeControlText.closest = () => separator;
      const firstHunkTextEvent = interactionEvent("click", [nativeControlText, separator]);
      listeners.get("click")?.(firstHunkTextEvent);

      expect(nativeInteractions).toEqual([0, 0]);
      expect(expanded).toEqual([
        [0, "down", undefined],
        [0, "down", undefined],
      ]);
      expect(firstHunkTextEvent.defaultPrevented).toBe(true);
    } finally {
      Reflect.set(PierreReviewFileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("nests an unmanaged diff and adapts public selection and annotation hooks", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = PierreReviewFileDiff.prototype.render;
    class TestHTMLElement extends EventTarget {
      shadowRoot = { replaceChildren() {} };
      dataset: Record<string, string> = {};
      children: TestHTMLElement[] = [];
      appendChild(child: TestHTMLElement) { this.children.push(child); return child; }
      setAttribute() {}
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });
    const partial = processFile(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -4,4 +4,4 @@
 one
 two
-old
+new
 four
`);
    if (!partial) throw new Error("Expected parsed diff");
    let renderProps: Record<string, unknown> | null = null;
    Reflect.set(PierreReviewFileDiff.prototype, "render", function render(
      this: PierreReviewFileDiff,
      props: Record<string, unknown>,
    ) {
      renderProps = props;
      return true;
    });
    try {
      const host: ReactiveControllerHost = {
        addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true),
      };
      const comments = new InlineReviewComments();
      comments.reconcile("scope", [{ fileId: "file-a", contentKey: "one" }]);
      const controller = createReviewFileDiffRenderer(host, undefined, undefined, undefined, undefined, null);
      const target = {
        fileDiff: partial,
        nativeExpandedHunks: new Map(),
        initialExpansion: null,
        comments,
        fileId: "file-a",
      };
      const bindingValues = Reflect.get(controller.bind(target), "values");
      const attach = Array.isArray(bindingValues) ? bindingValues[0] : null;
      if (typeof attach !== "function") throw new Error("Expected renderer ref binding");
      const mount = new TestHTMLElement();
      attach(mount);
      const instance = controller.instance;
      if (!instance) throw new Error("Expected renderer instance");

      instance.options.onLineSelected?.({ start: 7, end: 4, side: "additions", endSide: "additions" });
      expect(comments.project("file-a").selection).toEqual({ side: "new", startLine: 4, endLine: 7 });
      instance.options.onGutterUtilityClick?.({ start: 4, end: 7, side: "deletions", endSide: "additions" });
      expect(comments.project("file-a").error).toBe("Inline comments must stay on one side of the diff.");
      instance.options.onGutterUtilityClick?.({ start: 4, end: 7, side: "additions", endSide: "additions" });

      let annotations: Parameters<typeof instance.setLineAnnotations>[0] = [];
      const selections: Array<SelectedLineRange | null> = [];
      let rerenders = 0;
      instance.setLineAnnotations = (value) => { annotations = value; };
      instance.setSelectedLines = (value) => { selections.push(value); };
      instance.rerender = () => { rerenders += 1; };
      controller.refreshInlineComments();

      expect(renderProps).toMatchObject({ containerWrapper: mount });
      expect(renderProps).not.toHaveProperty("fileContainer");
      expect(annotations).toEqual([{
        side: "additions",
        lineNumber: 7,
        metadata: { placementId: comments.project("file-a").placements[0]?.id },
      }]);
      expect(selections).toEqual([{
        start: 4,
        end: 7,
        side: "additions",
        endSide: "additions",
      }]);
      expect(rerenders).toBe(1);

      const annotation = annotations[0];
      if (!annotation) throw new Error("Expected annotation");
      const annotationElement = instance.options.renderAnnotation?.(annotation);
      if (!(annotationElement instanceof InlineReviewCommentPlacementElement)) {
        throw new Error("Expected Reins annotation element");
      }
      expect(annotationElement.comments).toBe(comments);
      expect(annotationElement.fileId).toBe("file-a");
      expect(annotationElement.placementId).toBe(comments.project("file-a").placements[0]?.id);
    } finally {
      Reflect.set(PierreReviewFileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("does not offer context when patch metadata has no known collapsed region", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = PierreReviewFileDiff.prototype.render;
    const queryResults = new Map<string, EventTarget[]>();
    const root = {
      addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
      querySelectorAll(selector: string) { return queryResults.get(selector) ?? []; },
      replaceChildren() {},
    };
    class TestHTMLElement extends EventTarget {
      shadowRoot = root;
      dataset: Record<string, string> = {};
      nextElementSibling: TestHTMLElement | null = null;
      tabIndex = -1;
      private readonly attributes = new Map<string, string>();
      constructor(attributes: string[] = []) {
        super();
        for (const attribute of attributes) this.attributes.set(attribute, "");
      }
      hasAttribute(name: string) { return this.attributes.has(name); }
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
      closest: () => TestHTMLElement | null = () => null;
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });
    const partial = processFile(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
`);
    if (!partial) throw new Error("Expected parsed partial diff");
    const separator = new TestHTMLElement(["data-separator"]);
    const nextLine = new TestHTMLElement();
    nextLine.dataset.lineIndex = `${partial.hunks[0]?.unifiedLineStart},${partial.hunks[0]?.splitLineStart}`;
    separator.nextElementSibling = nextLine;
    const control = new TestHTMLElement(["data-separator-content"]);
    control.closest = () => separator;
    queryResults.set("[data-separator-content]", [control]);
    Reflect.set(PierreReviewFileDiff.prototype, "render", function render(
      this: PierreReviewFileDiff,
      props: { containerWrapper: HTMLElement },
    ) {
      this.options.onPostRender?.(props.containerWrapper, this, "mount");
      return true;
    });
    try {
      const host: ReactiveControllerHost = {
        addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true),
      };
      const controller = createReviewFileDiffRenderer(
        host, undefined, undefined, undefined, undefined, null,
      );
      const bindingValues = Reflect.get(controller.bind({
        fileDiff: partial, nativeExpandedHunks: new Map(), initialExpansion: null,
      }), "values");
      const attach = Array.isArray(bindingValues) ? bindingValues[0] : null;
      if (typeof attach !== "function") throw new Error("Expected renderer ref binding");
      attach(new TestHTMLElement());

      expect(control.dataset.reinsAcquireHunkIndex).toBeUndefined();
    } finally {
      Reflect.set(PierreReviewFileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });
});
