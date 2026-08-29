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
  PierreReviewFileDiff,
} from "../../../components/changes/review-file-diff-renderer.js";

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

      expect(control.dataset.reinsAcquireHunkIndex).toBeUndefined();
    } finally {
      Reflect.set(PierreReviewFileDiff.prototype, "render", originalRender);
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });
});
