import { describe, expect, test } from "bun:test";
import { SwipePagerSwipe, type SwipePagerSwipeState } from "../../models/swipe-pager-swipe.js";

function pointerEvent(fields: {
  isPrimary?: boolean;
  target?: EventTarget | null;
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
  currentTarget?: EventTarget | null;
  preventDefault?: () => void;
  composedPath?: () => EventTarget[];
}): PointerEvent {
  // @ts-expect-error The tests supply the PointerEvent fields SwipePagerSwipe reads.
  return fields;
}

describe("SwipePagerSwipe", () => {
  test("owns a horizontal swipe through its release spring", () => {
    const originalHTMLElement = globalThis.HTMLElement;
    const originalWindow = globalThis.window;
    const frameCallbacks: FrameRequestCallback[] = [];
    const states: SwipePagerSwipeState[] = [];
    const commits: number[] = [];
    let done = false;

    Reflect.set(globalThis, "HTMLElement", function HTMLElement() {});
    Reflect.set(globalThis, "window", {
      innerWidth: 390,
      setTimeout(fn: () => void) { fn(); return 0; },
      requestAnimationFrame(callback: FrameRequestCallback) {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame() {},
    });

    try {
      const swipe = SwipePagerSwipe.start({
        event: pointerEvent({
          isPrimary: true,
          target: null,
          pointerId: 1,
          clientX: 0,
          clientY: 0,
          timeStamp: 0,
        }),
        page: 4,
        pageCount: 6,
        getViewportWidth: () => 390,
        onStateChange: (state) => states.push({ ...state }),
        onCommitPage: (page) => commits.push(page),
        onDone: () => { done = true; },
      });

      expect(swipe).not.toBeNull();

      swipe?.move(pointerEvent({
        pointerId: 1,
        clientX: -220,
        clientY: 0,
        timeStamp: 16,
        currentTarget: null,
        preventDefault() {},
      }));

      expect(states.at(-1)).toEqual({ translateX: -1780, dragging: true, settling: false });

      swipe?.end(pointerEvent({
        pointerId: 1,
        clientX: -260,
        clientY: 0,
        timeStamp: 56,
      }));

      expect(states.at(-1)).toEqual({ translateX: -1780, dragging: false, settling: true });
      expect(commits).toEqual([]);
      expect(done).toBe(false);

      for (let index = 0; index < frameCallbacks.length; index += 1) {
        frameCallbacks[index](index * 16);
        if (done) break;
      }

      expect(commits).toEqual([5]);
      expect(states.at(-1)).toEqual({ translateX: null, dragging: false, settling: false });
      expect(done).toBe(true);
    } finally {
      Reflect.set(globalThis, "HTMLElement", originalHTMLElement);
      Reflect.set(globalThis, "window", originalWindow);
    }
  });

  test("adds resistance when dragging past either configured end", () => {
    const states: SwipePagerSwipeState[] = [];
    const swipe = SwipePagerSwipe.start({
      event: pointerEvent({ isPrimary: true, target: null, pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 }),
      page: 0,
      pageCount: 4,
      getViewportWidth: () => 390,
      onStateChange: (state) => states.push({ ...state }),
      onCommitPage() {},
      onDone() {},
    });

    swipe?.move(pointerEvent({
      pointerId: 1,
      clientX: 100,
      clientY: 0,
      timeStamp: 16,
      currentTarget: null,
      preventDefault() {},
    }));

    expect(states.at(-1)?.translateX).toBe(40);
  });

  test("abandons vertical drags so scrolling can continue", () => {
    const states: SwipePagerSwipeState[] = [];
    let done = false;
    const swipe = SwipePagerSwipe.start({
      event: pointerEvent({ isPrimary: true, target: null, pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 }),
      page: 1,
      pageCount: 4,
      getViewportWidth: () => 390,
      onStateChange: (state) => states.push({ ...state }),
      onCommitPage() {},
      onDone: () => { done = true; },
    });

    swipe?.move(pointerEvent({
      pointerId: 1,
      clientX: 16,
      clientY: 30,
      timeStamp: 16,
      currentTarget: null,
      preventDefault() { throw new Error("vertical drag should not be prevented"); },
    }));

    expect(done).toBe(true);
    expect(states).toEqual([]);
  });

  test("lets a nested horizontal scroller own the drag even at scroll edges", () => {
    const originalElement = globalThis.Element;
    const originalHTMLElement = globalThis.HTMLElement;

    class FakeElement extends EventTarget {
      parentElement: FakeElement | null = null;
      scrollWidth = 1000;
      clientWidth = 300;

      closest() {
        return null;
      }
    }

    Reflect.set(globalThis, "Element", FakeElement);
    Reflect.set(globalThis, "HTMLElement", FakeElement);

    try {
      const scroller = new FakeElement();
      const child = new FakeElement();
      child.parentElement = scroller;
      child.scrollWidth = 300;
      child.clientWidth = 300;
      const states: SwipePagerSwipeState[] = [];
      let done = false;
      let prevented = false;

      const swipe = SwipePagerSwipe.start({
        event: pointerEvent({ isPrimary: true, target: child, pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 }),
        page: 1,
        pageCount: 4,
        getViewportWidth: () => 390,
        onStateChange: (state) => states.push({ ...state }),
        onCommitPage() {},
        onDone: () => { done = true; },
      });

      swipe?.move(pointerEvent({
        pointerId: 1,
        clientX: -30,
        clientY: 0,
        timeStamp: 16,
        currentTarget: null,
        preventDefault() { prevented = true; },
      }));

      expect(done).toBe(true);
      expect(prevented).toBe(false);
      expect(states).toEqual([]);
    } finally {
      Reflect.set(globalThis, "Element", originalElement);
      Reflect.set(globalThis, "HTMLElement", originalHTMLElement);
    }
  });

  test("uses native element semantics for interactive controls", () => {
    const originalElement = globalThis.Element;

    class FakeElement extends EventTarget {
      constructor(
        private readonly opts: {
          interactive?: boolean;
          formControl?: boolean;
          swipeSurface?: boolean;
        },
      ) {
        super();
      }

      closest(selector: string) {
        if (selector === "[data-swipe-pager-surface]") {
          return this.opts.swipeSurface ? this : null;
        }
        if ((selector.includes("input") || selector.includes("textarea") || selector.includes("select")) && this.opts.formControl) {
          return this;
        }
        if ((selector.includes("button") || selector.includes("[role='button']")) && this.opts.interactive) {
          return this;
        }
        return null;
      }
    }

    const start = (target: EventTarget) => SwipePagerSwipe.start({
      event: pointerEvent({ isPrimary: true, target, pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 }),
      page: 1,
      pageCount: 4,
      getViewportWidth: () => 390,
      onStateChange() {},
      onCommitPage() {},
      onDone() {},
    });

    Reflect.set(globalThis, "Element", FakeElement);

    try {
      expect(start(new FakeElement({ interactive: true, swipeSurface: true }))).not.toBeNull();
      expect(start(new FakeElement({ interactive: true }))).toBeNull();
      expect(start(new FakeElement({ formControl: true, swipeSurface: true }))).toBeNull();
      expect(start(new FakeElement({ swipeSurface: true }))).not.toBeNull();
    } finally {
      Reflect.set(globalThis, "Element", originalElement);
    }
  });
});
