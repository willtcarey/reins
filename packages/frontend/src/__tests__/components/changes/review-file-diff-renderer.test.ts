import { describe, expect, test } from "bun:test";
import type { ExpansionDirections, FileDiffMetadata } from "@pierre/diffs";
import type { ReactiveControllerHost } from "lit";
import {
  createReviewFileDiffRenderer,
  metadataWithNativeExpansionControls,
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
  test("exposes Pierre's native controls without making partial metadata expandable", () => {
    const partial: FileDiffMetadata = {
      name: "file.txt",
      type: "change",
      isPartial: true,
      hunks: [],
      additionLines: [],
      deletionLines: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      cacheKey: "partial-v1",
    };

    const presentation = metadataWithNativeExpansionControls(partial);

    expect(presentation).not.toBe(partial);
    expect(presentation.isPartial).toBe(false);
    expect(partial.isPartial).toBe(true);
    expect(presentation.hunks).toBe(partial.hunks);
    expect(presentation.additionLines).toBe(partial.additionLines);
    expect(presentation.deletionLines).toBe(partial.deletionLines);
    expect(presentation.cacheKey).toBe("partial-v1:native-expansion-controls");
  });

  test("intercepts acquisition on native partial controls and delegates keyboard expansion after completion", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalRender = ReviewFileDiff.prototype.render;
    const listeners = new Map<string, EventListener>();
    const root = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === "function") listeners.set(type, listener);
      },
      removeEventListener(type: string) { listeners.delete(type); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      replaceChildren() {},
    };
    class TestHTMLElement extends EventTarget {
      shadowRoot = root;
      dataset: Record<string, string> = {};
      private readonly attributes = new Set<string>();
      constructor(attributes: string[] = []) {
        super();
        for (const attribute of attributes) this.attributes.add(attribute);
      }
      hasAttribute(name: string) { return this.attributes.has(name); }
      closest: () => TestHTMLElement | null = () => null;
      getBoundingClientRect() { return { top: 20 }; }
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });

    const partial: FileDiffMetadata = {
      name: "file.txt",
      type: "change",
      isPartial: true,
      hunks: [],
      additionLines: [],
      deletionLines: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
    };
    const complete = { ...partial, isPartial: false };
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
        (interaction) => nativeInteractions.push(interaction.hunkIndex),
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

      const separator = new TestHTMLElement();
      separator.dataset.expandIndex = "2";
      const control = new TestHTMLElement(["data-expand-button", "data-expand-down"]);
      control.closest = () => separator;
      const partialEvent = interactionEvent("click", [control, separator]);
      listeners.get("click")?.(partialEvent);

      expect(renderedMetadata[0]?.isPartial).toBe(false);
      expect(acquisitions).toEqual([2]);
      expect(partialEvent.defaultPrevented).toBe(true);
      expect(expanded).toEqual([]);

      controller.bind({ fileDiff: complete, nativeExpandedHunks: new Map(), initialExpansion: null });
      controller.hostUpdated();
      if (!controller.instance) throw new Error("Expected complete renderer");
      controller.instance.expandHunk = (hunkIndex, direction, lineCount) => {
        expanded.push([hunkIndex, direction, lineCount]);
      };
      const completeEvent = interactionEvent("keydown", [control, separator], { key: "Enter" });
      listeners.get("keydown")?.(completeEvent);

      expect(nativeInteractions).toEqual([2]);
      expect(expanded).toEqual([[2, "down", undefined]]);
      expect(completeEvent.defaultPrevented).toBe(true);
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
