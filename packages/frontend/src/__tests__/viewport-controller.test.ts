import { describe, expect, mock, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { ViewportController } from "../controllers/viewport-controller.js";

function fakeHost() {
  const host = {
    addController(_controller: ReactiveController) {},
    removeController(_controller: ReactiveController) {},
    requestUpdate: mock(() => {}),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  return host;
}

function installViewportGlobals(options: { mobile: boolean; standalone: boolean; viewportHeight?: number }) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

  let mobileChangeListener: ((event: { matches: boolean }) => void) | null = null;
  let resizeListener: (() => void) | null = null;
  const classList = { toggle: mock((_className: string, _force: boolean) => {}) };
  const visualViewport = options.viewportHeight == null
    ? undefined
    : {
        height: options.viewportHeight,
        addEventListener: mock((type: string, listener: () => void) => {
          if (type === "resize") resizeListener = listener;
        }),
        removeEventListener: mock((type: string, listener: () => void) => {
          if (type === "resize" && resizeListener === listener) resizeListener = null;
        }),
      };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes("max-width") ? options.mobile : options.standalone,
        addEventListener: mock((type: string, listener: (event: { matches: boolean }) => void) => {
          if (query.includes("max-width") && type === "change") mobileChangeListener = listener;
        }),
        removeEventListener: mock((type: string, listener: (event: { matches: boolean }) => void) => {
          if (query.includes("max-width") && type === "change" && mobileChangeListener === listener) {
            mobileChangeListener = null;
          }
        }),
      }),
      visualViewport,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { standalone: options.standalone },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { classList } },
  });

  return {
    classList,
    visualViewport,
    fireMobileChange(matches: boolean) { mobileChangeListener?.({ matches }); },
    fireViewportResize(height: number) {
      if (visualViewport) visualViewport.height = height;
      resizeListener?.();
    },
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

describe("ViewportController", () => {
  test("tracks mobile layout media query changes", () => {
    const globals = installViewportGlobals({ mobile: false, standalone: false });
    const host = fakeHost();
    const controller = new ViewportController(host);

    controller.hostConnected();
    expect(controller.isMobileLayout).toBe(false);

    globals.fireMobileChange(true);

    expect(controller.isMobileLayout).toBe(true);
    expect(host.requestUpdate).toHaveBeenCalled();
    controller.hostDisconnected();
    globals.restore();
  });

  test("toggles keyboard-open when the visual viewport shrinks", () => {
    const globals = installViewportGlobals({ mobile: true, standalone: true, viewportHeight: 800 });
    const controller = new ViewportController(fakeHost());

    controller.hostConnected();
    globals.fireViewportResize(500);

    expect(controller.isStandalone).toBe(true);
    expect(globals.classList.toggle).toHaveBeenCalledWith("keyboard-open", true);
    controller.hostDisconnected();
    globals.restore();
  });
});
