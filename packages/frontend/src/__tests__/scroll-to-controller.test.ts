import { describe, expect, mock, test } from "bun:test";
import type { ReactiveController } from "lit";
import {
  ScrollToController,
  type ScrollToElement,
  type ScrollToHost,
} from "../controllers/scroll-to-controller.js";

interface FakeHost extends ScrollToHost {
  controllers: ReactiveController[];
  setItems(next: ScrollToElement[]): void;
  disconnect(): void;
  updated(): void;
}

function fakeHost(items: ScrollToElement[] = []): FakeHost {
  const controllers: ReactiveController[] = [];
  return {
    addController(c: ReactiveController) { controllers.push(c); },
    removeController(c: ReactiveController) {
      const i = controllers.indexOf(c);
      if (i >= 0) controllers.splice(i, 1);
    },
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
    querySelectorAll() { return items; },
    get controllers() { return controllers; },
    setItems(next: ScrollToElement[]) { items = next; },
    disconnect() {
      for (const c of Array.from(controllers)) c.hostDisconnected?.();
    },
    updated() {
      for (const c of Array.from(controllers)) c.hostUpdated?.();
    },
  };
}

function fakeItem(options: {
  id: string;
  top: number;
  bottom: number;
  containerTop?: number;
  containerBottom?: number;
}) {
  const scrollIntoView = mock(() => {});
  const container = {
    getBoundingClientRect: () => ({
      top: options.containerTop ?? 0,
      bottom: options.containerBottom ?? 100,
    }),
  };

  const item: ScrollToElement & { scrollIntoViewMock: typeof scrollIntoView } = {
    id: options.id,
    getAttribute: (name: string) => name === "data-session-id" ? options.id : null,
    scrollIntoView,
    closest: () => container,
    getBoundingClientRect: () => ({ top: options.top, bottom: options.bottom }),
    scrollIntoViewMock: scrollIntoView,
  };
  return item;
}

describe("ScrollToController", () => {
  test("registers itself with the host", () => {
    const host = fakeHost();
    const ctrl = new ScrollToController(host, {
      getTargetId: () => "active",
      targetSelector: "[data-session-id]",
    });

    expect(host.controllers).toContain(ctrl);
  });

  test("centers the target item when it is outside the visible container", () => {
    const activeItem = fakeItem({ id: "active", top: 150, bottom: 180 });
    const host = fakeHost([activeItem]);
    const ctrl = new ScrollToController(host, {
      getTargetId: () => "active",
      targetSelector: "[data-session-id]",
      getItemId: (item) => item.getAttribute("data-session-id") ?? undefined,
      scrollContainerSelector: "[data-sidebar-scroll-container]",
    });

    expect(ctrl.scrollTargetIntoView()).toBe(true);
    expect(activeItem.scrollIntoViewMock).toHaveBeenCalledWith({ block: "center" });
  });

  test("does not scroll when the target item is already visible", () => {
    const activeItem = fakeItem({ id: "active", top: 20, bottom: 60 });
    const host = fakeHost([activeItem]);
    const ctrl = new ScrollToController(host, {
      getTargetId: () => "active",
      targetSelector: "[data-session-id]",
      getItemId: (item) => item.getAttribute("data-session-id") ?? undefined,
      scrollContainerSelector: "[data-sidebar-scroll-container]",
    });

    expect(ctrl.scrollTargetIntoView()).toBe(true);
    expect(activeItem.scrollIntoViewMock).toHaveBeenCalledTimes(0);
  });

  test("retries later when the target item has not rendered yet", () => {
    const host = fakeHost([]);
    const ctrl = new ScrollToController(host, {
      getTargetId: () => "active",
      targetSelector: "[data-session-id]",
      getItemId: (item) => item.getAttribute("data-session-id") ?? undefined,
      scrollContainerSelector: "[data-sidebar-scroll-container]",
    });

    expect(ctrl.scrollTargetIntoView()).toBe(false);

    const activeItem = fakeItem({ id: "active", top: 150, bottom: 180 });
    host.setItems([activeItem]);

    expect(ctrl.scrollTargetIntoView()).toBe(true);
    expect(activeItem.scrollIntoViewMock).toHaveBeenCalledWith({ block: "center" });
  });
});
