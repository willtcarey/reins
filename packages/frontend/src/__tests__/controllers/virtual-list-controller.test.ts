import { describe, expect, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  VirtualListController,
  type VirtualListContainer,
  type VirtualListObservation,
} from "../../controllers/virtual-list-controller.js";

interface FakeHost extends ReactiveControllerHost {
  readonly updates: number;
  updated(): void;
  disconnect(): void;
}

function fakeHost(): FakeHost {
  const controllers: ReactiveController[] = [];
  let updates = 0;
  return {
    addController(controller) { controllers.push(controller); },
    removeController(controller) {
      const index = controllers.indexOf(controller);
      if (index >= 0) controllers.splice(index, 1);
    },
    requestUpdate() { updates += 1; },
    updateComplete: Promise.resolve(true),
    get updates() { return updates; },
    updated() { controllers.forEach((controller) => controller.hostUpdated?.()); },
    disconnect() { controllers.forEach((controller) => controller.hostDisconnected?.()); },
  };
}

interface FakeContainer extends VirtualListContainer {
  readonly scrollCalls: ScrollToOptions[];
  fire(type: string, init?: Partial<KeyboardEvent>): void;
}

function fakeContainer(scrollTop: number, clientHeight: number): FakeContainer {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const scrollCalls: ScrollToOptions[] = [];
  return {
    scrollTop,
    clientHeight,
    scrollCalls,
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      callbacks.add(listener);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    scrollTo(options) {
      if (typeof options === "object") scrollCalls.push(options);
    },
    fire(type, init = {}) {
      const event = Object.assign(new Event(type), init);
      listeners.get(type)?.forEach((listener) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
    },
  };
}

const items = [
  { id: "above", measurementKey: "above-v1", estimatedHeight: 100 },
  { id: "visible", measurementKey: "visible-v1", estimatedHeight: 100 },
  { id: "below", measurementKey: "below-v1", estimatedHeight: 100 },
];

describe("VirtualListController", () => {
  test("batches stable measurements and applies one semantic anchor correction after render", async () => {
    const host = fakeHost();
    const observations: VirtualListObservation[] = [];
    const controller = new VirtualListController(host, 0, 100);
    controller.observe = (observation) => observations.push(observation);
    controller.setItems(items);
    const container = fakeContainer(150, 100);
    controller.attach(container);

    controller.measure({ id: "above", measurementKey: "above-v1", height: 140 });
    controller.measure({ id: "above", measurementKey: "above-v1", height: 160 });
    await Promise.resolve();

    expect(container.scrollTop).toBe(150);
    expect(controller.item("above")?.height).toBe(160);
    expect(observations.find((event) => event.type === "measurement-batch")).toMatchObject({
      type: "measurement-batch",
      submitted: 1,
      accepted: 1,
      scrollAdjustment: 60,
    });

    host.updated();

    expect(container.scrollTop).toBe(210);
    expect(controller.window().activeId).toBe("visible");
  });

  test("keeps an interacted point anchored after expanded item geometry is rendered", async () => {
    const host = fakeHost();
    const controller = new VirtualListController(host, 0, 100);
    controller.setItems(items);
    const container = fakeContainer(120, 100);
    controller.attach(container);

    controller.adjustScrollBy(60);
    expect(container.scrollTop).toBe(120);

    controller.measure({ id: "visible", measurementKey: "visible-v1", height: 160 });
    await Promise.resolve();
    expect(container.scrollTop).toBe(120);

    host.updated();

    expect(container.scrollTop).toBe(180);
    expect(controller.window().activeId).toBe("visible");
  });

  test("scrolls down by item growth when context expands upward", async () => {
    const host = fakeHost();
    const controller = new VirtualListController(host, 0, 100);
    controller.setItems(items);
    const container = fakeContainer(120, 100);
    controller.attach(container);

    controller.adjustScrollByItemGrowth("visible");
    controller.measure({ id: "visible", measurementKey: "visible-v1", height: 160 });
    await Promise.resolve();
    host.updated();

    expect(container.scrollTop).toBe(180);
    expect(controller.window().activeId).toBe("visible");
  });

  test("does not apply a stale point correction after user scroll intent", async () => {
    const host = fakeHost();
    const controller = new VirtualListController(host, 0, 100);
    controller.setItems(items);
    const container = fakeContainer(120, 100);
    controller.attach(container);

    controller.adjustScrollBy(60);
    container.fire("wheel");
    controller.measure({ id: "visible", measurementKey: "visible-v1", height: 160 });
    await Promise.resolve();
    host.updated();

    expect(container.scrollTop).toBe(120);
  });

  test("uses fixed geometry without discarding a prior fluid measurement", async () => {
    const host = fakeHost();
    const controller = new VirtualListController(host, 0);
    controller.setItems([{ id: "file", measurementKey: "file-v1", estimatedHeight: 100 }]);
    controller.measure({ id: "file", measurementKey: "file-v1", height: 180 });
    await Promise.resolve();
    expect(controller.item("file")?.height).toBe(180);

    controller.setItems([{
      id: "file",
      measurementKey: "file-v1",
      estimatedHeight: 100,
      fixedHeight: 37,
    }]);
    controller.measure({ id: "file", measurementKey: "file-v1", height: 41 });
    await Promise.resolve();
    expect(controller.item("file")?.height).toBe(37);

    controller.setItems([{ id: "file", measurementKey: "file-v1", estimatedHeight: 100 }]);
    expect(controller.item("file")?.height).toBe(180);
  });

  test("navigates to unmounted IDs, retargets after geometry changes, and cancels on user input", async () => {
    const host = fakeHost();
    const controller = new VirtualListController(host, 100, 300);
    controller.setItems(Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      measurementKey: `item-${index}`,
      estimatedHeight: 100,
    })));
    const container = fakeContainer(0, 300);
    controller.attach(container);

    expect(controller.window().items.some((item) => item.id === "item-99")).toBe(false);
    expect(controller.navigateTo("item-99")).toBe(true);
    expect(container.scrollCalls.at(-1)).toEqual({ top: 9_700, behavior: "smooth" });

    controller.measure({ id: "item-0", measurementKey: "item-0", height: 500 });
    await Promise.resolve();
    host.updated();
    expect(container.scrollCalls.at(-1)).toEqual({ top: 10_100, behavior: "smooth" });

    container.fire("wheel");
    controller.measure({ id: "item-1", measurementKey: "item-1", height: 500 });
    await Promise.resolve();
    host.updated();

    expect(container.scrollCalls.at(-1)).toEqual({ top: 0, behavior: "auto" });
  });

  test("completes navigation at a bottom-clamped destination even when another item is active", () => {
    const host = fakeHost();
    const observations: VirtualListObservation[] = [];
    const controller = new VirtualListController(host, 0, 300);
    controller.observe = (observation) => observations.push(observation);
    controller.setItems(Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      measurementKey: `item-${index}`,
      estimatedHeight: 100,
    })));
    const container = fakeContainer(0, 300);
    controller.attach(container);

    controller.navigateTo("item-99");
    container.scrollTop = 9_700;
    container.fire("scroll");

    expect(controller.window().activeId).toBe("item-97");
    expect(observations.at(-1)).toMatchObject({
      type: "navigation-complete",
      targetId: "item-99",
      actualTop: 9_700,
    });
  });

  test("synchronizes scroll state immediately and coalesces rendering to one frame", () => {
    const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    try {
      const host = fakeHost();
      const observations: VirtualListObservation[] = [];
      const controller = new VirtualListController(host, 0, 100);
      controller.observe = (observation) => observations.push(observation);
      controller.setItems(items);
      const container = fakeContainer(0, 100);
      controller.attach(container);
      const updatesBeforeScroll = host.updates;

      container.scrollTop = 150;
      container.fire("scroll");
      container.fire("scroll");

      expect(controller.window().activeId).toBe("visible");
      expect(observations.filter((event) => event.type === "scroll").at(-1)).toMatchObject({
        type: "scroll",
        activeId: "visible",
        actualTop: 150,
      });
      expect(frames).toHaveLength(1);
      expect(host.updates).toBe(updatesBeforeScroll);

      frames[0]!(0);
      expect(host.updates).toBe(updatesBeforeScroll + 1);
    } finally {
      if (frameDescriptor) Object.defineProperty(globalThis, "requestAnimationFrame", frameDescriptor);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
  });

  test("preserves a measurable scroll position across a hidden zero-height cycle", () => {
    const host = fakeHost();
    const controller = new VirtualListController(host, 0);
    controller.setItems(items);
    const container = fakeContainer(175, 100);
    controller.attach(container);
    controller.setVisible(true);
    container.fire("scroll");

    controller.setVisible(false);
    container.scrollTop = 0;
    container.clientHeight = 0;
    controller.setVisible(true);
    container.scrollTop = 20;
    container.clientHeight = 100;
    host.updated();

    expect(container.scrollTop).toBe(175);
  });
});
