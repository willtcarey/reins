import { describe, expect, test } from "bun:test";
import {
  parseDiffFromFile,
  processFile,
  type ExpansionDirections,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import {
  createReviewFileDiffRenderer,
  ReviewFileDiff,
} from "../../../components/changes/review-file-diff-renderer.js";

function interactionEvent(type: string, path: EventTarget[], properties: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "composedPath", { value: () => path });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

describe("ReviewFileDiff", () => {
  test("reproduces Shiki's invalid decoration crash when partial arrays are marked complete", () => {
    const prefix = "const value = someCall(abcdefghijklmno";
    const deletions = Array.from({ length: 21 }, (_, index) => `-${prefix}old${index});`).join("\n");
    const additions = Array.from({ length: 21 }, (_, index) => `+${prefix}new${index});`).join("\n");
    const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -33,21 +33,21 @@
${deletions}
${additions}
`;
    const partial = processFile(patch);
    if (!partial) throw new Error("Expected parsed partial diff");

    // Run real Shiki outside Bun's process-wide module mocks used by worker tests.
    const reproduction = Bun.spawnSync({
      cmd: [process.execPath, "-e", `
        const { processFile, renderDiffWithHighlighter } = await import(${JSON.stringify(import.meta.resolve("@pierre/diffs"))});
        const { createHighlighter } = await import(${JSON.stringify(import.meta.resolve("shiki"))});
        const partial = processFile(${JSON.stringify(patch)});
        const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
        renderDiffWithHighlighter({ ...partial, isPartial: false }, highlighter, {
          theme: "github-dark",
          useTokenTransformer: false,
          tokenizeMaxLineLength: 1000,
          lineDiffType: "word-alt",
          maxLineDiffLength: 1000,
        });
      `],
      stderr: "pipe",
    });

    expect(reproduction.exitCode).not.toBe(0);
    expect(reproduction.stderr.toString()).toMatch(
      /Invalid decoration position.*"line":32.*Lines length: 21/,
    );
    expect(partial.isPartial).toBe(true);
  });

  test("renders a visible partial acquisition button without loading until activation", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = ReviewFileDiff.prototype.render;
    const listeners = new Map<string, EventListener>();
    const queryResults = new Map<string, EventTarget[]>();
    const root = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") listeners.set(type, listener);
      },
      removeEventListener(type: string) { listeners.delete(type); },
      querySelector() { return null; },
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
    const unchanged = Array.from({ length: 32 }, (_, index) => `line ${index + 1}`).join("\n");
    const complete = parseDiffFromFile(
      { name: "file.txt", contents: `${unchanged}\nold\n` },
      { name: "file.txt", contents: `${unchanged}\nnew\n` },
    );
    const renderedMetadata: FileDiffMetadata[] = [];
    const expanded: Array<[number, ExpansionDirections, number | undefined]> = [];
    Reflect.set(ReviewFileDiff.prototype, "render", function render(
      this: ReviewFileDiff,
      props: { fileDiff: FileDiffMetadata; fileContainer: HTMLElement },
    ) {
      renderedMetadata.push(props.fileDiff);
      this.options.onPostRender?.(props.fileContainer, this, "mount");
      return true;
    });
    try {
      const host: ReactiveControllerHost = {
        addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true),
      };
      const acquisitions: number[] = [];
      const nativeInteractions: number[] = [];
      const controller = createReviewFileDiffRenderer(
        host,
        undefined,
        (interaction) => acquisitions.push(interaction.hunkIndex),
        (interaction, mutate) => {
          nativeInteractions.push(interaction.hunkIndex);
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
      expect(separator.dataset.expandIndex).toBeUndefined();
      expect(control.dataset.reinsAcquireHunkIndex).toBe("0");
      expect(control.getAttribute("role")).toBe("button");
      expect(control.getAttribute("aria-label")).toBe("Expand unchanged lines");
      expect(control.tabIndex).toBe(0);
      expect(control.style.borderTopLeftRadius).toBe("0px");
      expect(control.style.borderBottomLeftRadius).toBe("0px");
      expect(acquisitionButton.hasAttribute("data-expand-button")).toBe(true);
      expect(acquisitionButton.hasAttribute("data-expand-down")).toBe(true);
      expect(acquisitionButton.dataset.reinsAcquireHunkIndex).toBe("0");
      expect(acquisitionButton.getAttribute("aria-label")).toBe("Expand unchanged lines above");
      expect(acquisitionButton.tabIndex).toBe(0);
      expect(acquisitionButton.children).toHaveLength(1);
      expect(acquisitions).toEqual([0]);
      expect(partialEvent.defaultPrevented).toBe(true);
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
      Reflect.set(ReviewFileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("does not offer context when patch metadata has no known collapsed region", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = ReviewFileDiff.prototype.render;
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
    Reflect.set(ReviewFileDiff.prototype, "render", function render(
      this: ReviewFileDiff,
      props: { fileContainer: HTMLElement },
    ) {
      this.options.onPostRender?.(props.fileContainer, this, "mount");
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

      expect(partial.hunks[0]?.collapsedBefore).toBe(0);
      expect(control.dataset.reinsAcquireHunkIndex).toBeUndefined();
    } finally {
      Reflect.set(ReviewFileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("uses Pierre's line-info option and native expandHunk state", () => {
    const renderer = new ReviewFileDiff({
      diffStyle: "unified",
      hunkSeparators: "line-info",
      expansionLineCount: 5,
      disableFileHeader: true,
    });

    renderer.expandHunk(0, "down");

    expect(renderer.options.hunkSeparators).toBe("line-info");
    expect(renderer.nativeExpansionState()).toEqual(new Map([
      [0, { fromStart: 0, fromEnd: 5 }],
    ]));
  });

  test("releases renderer interaction listeners during cleanup", () => {
    const renderer = new ReviewFileDiff();
    let cleanups = 0;
    renderer.setInteractionCleanup(() => { cleanups += 1; });

    renderer.cleanUp();

    expect(cleanups).toBe(1);
  });

  test("restores remounted expansion by delegating each retained region to native expandHunk", () => {
    const renderer = new ReviewFileDiff();
    const calls: Array<[number, ExpansionDirections, number | undefined]> = [];
    renderer.expandHunk = (hunkIndex, direction, lineCount) => {
      calls.push([hunkIndex, direction, lineCount]);
    };

    renderer.restoreNativeExpansion(new Map([
      [0, { fromStart: 15, fromEnd: 5 }],
      [2, { fromStart: 0, fromEnd: 30 }],
    ]));

    expect(calls).toEqual([
      [0, "up", 15],
      [0, "down", 5],
      [2, "down", 30],
    ]);
  });
});
