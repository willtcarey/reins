import { describe, expect, mock, test } from "bun:test";
import { html } from "lit";
import { PopoverMenu } from "../../ui/popover-menu.js";
import { templateToString } from "../helpers/lit-template.js";

describe("PopoverMenu", () => {
  test("keeps the panel open on internal clicks by default", () => {
    const el = new PopoverMenu();
    // @ts-expect-error testing internal state
    el.open = true;
    // @ts-expect-error testing internal method
    el.onPanelClick();
    // @ts-expect-error testing internal state
    expect(el.open).toBe(true);
  });

  test("closes the panel on internal clicks when opted in", () => {
    const el = new PopoverMenu();
    el.closeOnPanelClick = true;
    // @ts-expect-error testing internal state
    el.open = true;
    // @ts-expect-error testing internal method
    el.onPanelClick();
    // @ts-expect-error testing internal state
    expect(el.open).toBe(false);
  });

  test("keeps the panel open while its content scrolls", () => {
    const el = new PopoverMenu();
    const scroller = {};
    el.content = () => html`<div>Scrollable content</div>`;
    // @ts-expect-error testing rendered open state
    el.open = true;

    // @ts-expect-error exercising the document scroll listener
    el._onScroll({ composedPath: () => [scroller, el] });

    expect(templateToString(el.render())).toContain('popover="manual"');
  });

  test("dismisses without activating the background when clicked outside", () => {
    const el = new PopoverMenu();
    const preventDefault = mock(() => {});
    const stopPropagation = mock(() => {});
    el.content = () => html`<div>Popover content</div>`;
    // @ts-expect-error testing rendered open state
    el.open = true;

    // @ts-expect-error exercising the document click listener
    el._onDocClick({ composedPath: () => [], preventDefault, stopPropagation });

    expect(templateToString(el.render())).not.toContain('popover="manual"');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  test("closes the panel when an external container scrolls", () => {
    const el = new PopoverMenu();
    el.content = () => html`<div>Popover content</div>`;
    // @ts-expect-error testing rendered open state
    el.open = true;

    // @ts-expect-error exercising the document scroll listener
    el._onScroll({ composedPath: () => [{}] });

    expect(templateToString(el.render())).not.toContain('popover="manual"');
  });

  test("promotes an open panel to the top layer so transformed panes do not offset it", () => {
    const el = new PopoverMenu();
    const showPopover = mock(() => {});
    el.content = () => html`<button>Action</button>`;
    // @ts-expect-error testing rendered open state
    el.open = true;
    Reflect.set(el, "renderRoot", {
      querySelector: () => ({ matches: () => false, showPopover }),
    });

    const output = templateToString(el.render());
    el.updated();

    expect(output).toContain('popover="manual"');
    expect(showPopover).toHaveBeenCalledTimes(1);
  });

  test("repositions when async popover content changes the panel size", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    let notifyResize: (() => void) | undefined;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { innerWidth: 320, innerHeight: 640 },
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    });

    try {
      const el = new PopoverMenu();
      const panelStyle: Record<string, string> = {};
      let panelWidth = 100;
      const panel = {
        matches: () => false,
        showPopover: mock(() => {}),
        get offsetWidth() { return panelWidth; },
        offsetHeight: 192,
        style: panelStyle,
      };
      const trigger = {
        getBoundingClientRect: () => ({
          left: 140,
          right: 160,
          top: 400,
          bottom: 420,
          width: 20,
          height: 20,
        }),
      };
      el.anchor = "right-end";
      el.content = () => html`<div>Model picker</div>`;
      // @ts-expect-error testing rendered open state
      el.open = true;
      Reflect.set(el, "renderRoot", {
        querySelector: (selector: string) => selector === "button" ? trigger : panel,
      });

      el.updated();
      expect(panelStyle.left).toBe("60px");

      panelWidth = 304;
      notifyResize?.();

      expect(panelStyle.left).toBe("4px");
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  test("clamps side-anchored panels within a narrow mobile viewport", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { innerWidth: 320, innerHeight: 640 },
    });

    try {
      const el = new PopoverMenu();
      const panelStyle: Record<string, string> = {};
      const panel = {
        matches: () => false,
        showPopover: mock(() => {}),
        offsetWidth: 256,
        offsetHeight: 192,
        style: panelStyle,
      };
      const trigger = {
        getBoundingClientRect: () => ({
          left: 260,
          right: 280,
          top: 100,
          bottom: 120,
          width: 20,
          height: 20,
        }),
      };
      el.anchor = "right-start";
      el.content = () => html`<div>Sub-sessions</div>`;
      // @ts-expect-error testing rendered open state
      el.open = true;
      Reflect.set(el, "renderRoot", {
        querySelector: (selector: string) => selector === "button" ? trigger : panel,
      });

      el.updated();

      expect(panelStyle.left).toBe("4px");
      expect(panelStyle.top).toBe("100px");
      expect(templateToString(el.render())).toContain("max-w-[calc(100vw-0.5rem)]");
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});
