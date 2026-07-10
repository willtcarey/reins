import { describe, expect, test } from "bun:test";
import type { ReactiveController } from "lit";
import { PageSwipeController } from "../../controllers/page-swipe-controller.js";

class FakeHost extends EventTarget {
  controllers: ReactiveController[] = [];
  updateComplete = Promise.resolve(true);
  updates = 0;

  addController(controller: ReactiveController) {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController) {
    this.controllers = this.controllers.filter((item) => item !== controller);
  }

  requestUpdate() {
    this.updates += 1;
  }
}

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
  // @ts-expect-error The tests supply the PointerEvent fields PageSwipeController reads.
  return fields;
}

describe("PageSwipeController", () => {
  test("owns page swipe event plumbing and commits the settled page", () => {
    const originalWindow = globalThis.window;
    const frameCallbacks: FrameRequestCallback[] = [];
    const commits: number[] = [];
    const host = new FakeHost();
    let page = 1;

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
      const controller = new PageSwipeController(host, {
        pageCount: 4,
        getPage: () => page,
        commitPage: (nextPage) => {
          page = nextPage;
          commits.push(nextPage);
        },
        isEnabled: () => true,
      });

      controller.handlePointerDown(pointerEvent({
        isPrimary: true,
        target: null,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        timeStamp: 0,
      }));
      controller.handlePointerMove(pointerEvent({
        pointerId: 1,
        clientX: -180,
        clientY: 0,
        timeStamp: 16,
        currentTarget: null,
        preventDefault() {},
      }));

      expect(controller.translateX).toBe(-570);
      expect(controller.dragging).toBe(true);
      expect(host.updates).toBeGreaterThan(0);

      controller.handlePointerEnd(pointerEvent({
        pointerId: 1,
        clientX: -220,
        clientY: 0,
        timeStamp: 48,
      }));

      expect(controller.settling).toBe(true);
      expect(commits).toEqual([]);

      for (let index = 0; index < frameCallbacks.length; index += 1) {
        frameCallbacks[index](index * 16);
        if (commits.length > 0) break;
      }

      expect(commits).toEqual([2]);
      expect(controller.translateX).toBeNull();
      expect(controller.dragging).toBe(false);
      expect(controller.settling).toBe(false);
    } finally {
      Reflect.set(globalThis, "window", originalWindow);
    }
  });

  test("measures the swipe width from the event target", () => {
    const originalHTMLElement = globalThis.HTMLElement;

    class FakeElement extends EventTarget {
      clientWidth = 320;
    }

    Reflect.set(globalThis, "HTMLElement", FakeElement);

    try {
      const host = new FakeHost();
      const shell = new FakeElement();
      const controller = new PageSwipeController(host, {
        pageCount: 4,
        getPage: () => 1,
        commitPage() {},
        isEnabled: () => true,
      });

      controller.handlePointerDown(pointerEvent({
        isPrimary: true,
        target: null,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        timeStamp: 0,
        currentTarget: shell,
      }));
      controller.handlePointerMove(pointerEvent({
        pointerId: 1,
        clientX: -160,
        clientY: 0,
        timeStamp: 16,
        currentTarget: null,
        preventDefault() {},
      }));

      expect(controller.translateX).toBe(-480);
    } finally {
      Reflect.set(globalThis, "HTMLElement", originalHTMLElement);
    }
  });

  test("adds edge resistance at first and last pages", () => {
    const host = new FakeHost();
    const controller = new PageSwipeController(host, {
      pageCount: 4,
      getPage: () => 0,
      commitPage() {},
      isEnabled: () => true,
    });

    controller.handlePointerDown(pointerEvent({
      isPrimary: true,
      target: null,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      timeStamp: 0,
    }));
    controller.handlePointerMove(pointerEvent({
      pointerId: 1,
      clientX: 100,
      clientY: 0,
      timeStamp: 16,
      currentTarget: null,
      preventDefault() {},
    }));

    expect(controller.translateX).toBe(40);
  });

  test("cancels an active swipe when the page changes externally", () => {
    const originalWindow = globalThis.window;
    const frameCallbacks: FrameRequestCallback[] = [];
    const commits: number[] = [];
    const host = new FakeHost();
    let page = 2;

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
      const controller = new PageSwipeController(host, {
        pageCount: 4,
        getPage: () => page,
        commitPage: (nextPage) => {
          page = nextPage;
          commits.push(nextPage);
        },
        isEnabled: () => true,
      });

      controller.handlePointerDown(pointerEvent({
        isPrimary: true,
        target: null,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        timeStamp: 0,
      }));
      controller.handlePointerMove(pointerEvent({
        pointerId: 1,
        clientX: -180,
        clientY: 0,
        timeStamp: 16,
        currentTarget: null,
        preventDefault() {},
      }));

      expect(controller.translateX).toBe(-960);
      expect(controller.dragging).toBe(true);

      page = 1;
      controller.syncPage();

      expect(controller.translateX).toBeNull();
      expect(controller.dragging).toBe(false);
      expect(controller.settling).toBe(false);

      controller.handlePointerEnd(pointerEvent({
        pointerId: 1,
        clientX: -220,
        clientY: 0,
        timeStamp: 48,
      }));
      for (let index = 0; index < frameCallbacks.length; index += 1) {
        frameCallbacks[index](index * 16);
      }

      expect(commits).toEqual([]);
      expect(page).toBe(1);
    } finally {
      Reflect.set(globalThis, "window", originalWindow);
    }
  });

  test("ignores pointer starts while disabled", () => {
    const host = new FakeHost();
    const controller = new PageSwipeController(host, {
      pageCount: 4,
      getPage: () => 1,
      commitPage() {},
      isEnabled: () => false,
    });

    controller.handlePointerDown(pointerEvent({
      isPrimary: true,
      target: null,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      timeStamp: 0,
    }));
    controller.handlePointerMove(pointerEvent({
      pointerId: 1,
      clientX: -180,
      clientY: 0,
      timeStamp: 16,
      currentTarget: null,
      preventDefault() {},
    }));

    expect(controller.translateX).toBeNull();
    expect(controller.dragging).toBe(false);
  });
});
