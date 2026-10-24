import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactiveControllerHost } from "lit";
import { ScrollAnchorController } from "../../controllers/scroll-anchor-controller.js";

const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
afterEach(() => {
  if (originalResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

/** A box of the content, at `top` from the content's start, laid out again by setting `top` and `height`. */
class Box {
  isConnected = true;
  children: Box[];
  constructor(private view: Viewport, public top: number, public height: number, children: Box[] = []) {
    this.children = children;
  }
  getBoundingClientRect() {
    const top = this.top - this.view.scrollTop;
    return { top, bottom: top + this.height, width: this.view.clientWidth, height: this.height };
  }
}

/** A scroll container whose viewport is at the top of the page. */
class Viewport {
  isConnected = true;
  scrollTop = 0;
  clientWidth = 800;
  clientHeight = 600;
  children: Box[] = [];
  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
}

function anchored(layout: (view: Viewport) => Box[], scrollTop: number, options: { locked?: () => boolean } = {}) {
  const resized: Array<() => void> = [];
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor(callback: () => void) { resized.push(callback); }
      observe() {}
      disconnect() {}
    },
  });
  const view = new Viewport();
  view.children = layout(view);
  view.scrollTop = scrollTop;
  const host: ReactiveControllerHost = {
    addController: mock(() => undefined),
    removeController: mock(() => undefined),
    requestUpdate: mock(() => undefined),
    updateComplete: Promise.resolve(true),
  };
  const controller = new ScrollAnchorController(host, { container: () => view, locked: options.locked });
  const resize = () => { for (const callback of resized) callback(); };
  controller.hostUpdated();
  // An observer reports its targets' sizes when it starts observing them.
  resize();
  return { view, controller, resize };
}

describe("ScrollAnchorController", () => {
  test("keeps a container scrolled to its end at its end when it narrows or gets shorter", () => {
    let first!: Box, last!: Box;
    const { view, resize } = anchored((on) => [first = new Box(on, 0, 400), last = new Box(on, 400, 600)], 400);

    view.clientWidth = 600;
    first.height = 500;
    last.top = 500;
    last.height = 800;
    resize();
    expect(view.scrollTop).toBe(700);

    view.clientHeight = 500;
    resize();
    expect(view.scrollTop).toBe(800);
  });

  test("keeps the text at the bottom edge where it was last scrolled to", () => {
    let before!: Box, message!: Box, read!: Box, after!: Box;
    const { view, controller, resize } = anchored((on) => [
      before = new Box(on, 0, 500),
      message = new Box(on, 500, 1000, [new Box(on, 500, 300), read = new Box(on, 800, 400), after = new Box(on, 1200, 300)]),
    ], 0);
    view.scrollTop = 300;
    controller.save();

    view.clientWidth = 600;
    before.height = 700;
    message.top = 700;
    message.children[0]!.top = 700;
    message.children[0]!.height = 400;
    read.top = 1100;
    read.height = 600;
    after.top = 1700;
    resize();

    expect(read.getBoundingClientRect().top).toBe(500);
  });

  test("leaves the scroll alone when only the content changes, and anchors to it afterwards", () => {
    let expanded!: Box, read!: Box;
    const { view, resize } = anchored((on) => [expanded = new Box(on, 0, 100), read = new Box(on, 100, 2000)], 0);

    expanded.height = 300;
    read.top = 300;
    resize();
    expect(view.scrollTop).toBe(0);

    view.clientWidth = 600;
    read.top = 400;
    expanded.height = 400;
    resize();
    expect(read.getBoundingClientRect().top).toBe(300);
  });

  test("keeps the text in place when content is added above it while pinned, or when restored", () => {
    let read!: Box;
    const { view, controller, resize } = anchored((on) => [read = new Box(on, 0, 1000)], 100);
    const release = controller.pin();

    view.children = [new Box(view, 0, 500), read];
    read.top = 500;
    resize();
    expect(read.getBoundingClientRect().top).toBe(-100);

    view.children = [new Box(view, 0, 300), ...view.children];
    read.top = 800;
    controller.restore();
    expect(read.getBoundingClientRect().top).toBe(-100);

    release();
    read.top = 900;
    resize();
    expect(view.scrollTop).toBe(900);
  });

  test("keeps its anchor while hidden and while locked", () => {
    let locked = false;
    let read!: Box;
    const { view, resize } = anchored((on) => [new Box(on, 0, 1000), read = new Box(on, 1000, 1000)], 700, { locked: () => locked });

    view.clientWidth = 0;
    view.clientHeight = 0;
    resize();
    view.clientWidth = 800;
    view.clientHeight = 600;
    resize();
    expect(view.scrollTop).toBe(700);

    locked = true;
    view.clientWidth = 600;
    read.top = 1200;
    resize();
    expect(view.scrollTop).toBe(700);
  });
});
