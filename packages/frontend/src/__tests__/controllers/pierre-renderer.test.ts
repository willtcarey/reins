import { describe, expect, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { PierreRenderer } from "../../controllers/pierre-renderer.js";

interface Input {
  version: number;
}

interface Renderer {
  cleanUp(): void;
}

describe("PierreRenderer", () => {
  test("invalidates stale completion callbacks when a renderer generation is replaced", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    class TestHTMLElement { readonly tagName = "DIV"; }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });

    try {
      const host: ReactiveControllerHost = {
        addController() {},
        removeController() {},
        requestUpdate() {},
        updateComplete: Promise.resolve(true),
      };
      const completions: Array<() => void> = [];
      const controller = new PierreRenderer<Input, Renderer>(host, {
        create: (_input, rendered) => {
          completions.push(rendered);
          return { cleanUp() {} };
        },
        render() {},
        sameInput: (left, right) => left.version === right.version,
      });
      const firstBinding = controller.bind({ version: 1 });
      const firstValues = Reflect.get(firstBinding, "values");
      const attach = Array.isArray(firstValues) ? firstValues[0] : null;
      if (typeof attach !== "function") throw new Error("Expected a ref binding");
      const firstContainer = new TestHTMLElement();
      attach(firstContainer);

      attach(undefined);
      const secondBinding = controller.bind({ version: 1 });
      const secondValues = Reflect.get(secondBinding, "values");
      const reattach = Array.isArray(secondValues) ? secondValues[0] : null;
      if (typeof reattach !== "function") throw new Error("Expected a ref binding");
      reattach(new TestHTMLElement());

      completions[0]?.();
      expect(controller.rendered).toBe(false);
      completions[1]?.();
      expect(controller.rendered).toBe(true);
    } finally {
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("clears Pierre-owned shadow DOM when releasing and reusing a managed container", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const adoptedStyle = {};
    const shadowChildren: object[] = [];
    const shadowRoot = {
      adoptedStyleSheets: [adoptedStyle],
      get children() { return shadowChildren; },
      replaceChildren() { shadowChildren.length = 0; },
    };
    class TestHTMLElement { shadowRoot = shadowRoot; }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestHTMLElement });

    try {
      const host: ReactiveControllerHost = {
        addController() {},
        removeController() {},
        requestUpdate() {},
        updateComplete: Promise.resolve(true),
      };
      const controller = new PierreRenderer<Input, Renderer>(host, {
        create: () => ({ cleanUp() {} }),
        render: () => { shadowChildren.push({}, {}, {}); },
      });
      const binding = controller.bind({ version: 1 });
      const values = Reflect.get(binding, "values");
      const attach = Array.isArray(values) ? values[0] : null;
      if (typeof attach !== "function") throw new Error("Expected a ref binding");
      const container = new TestHTMLElement();
      attach(container);
      expect(shadowChildren).toHaveLength(3);

      controller.bind({ version: 2 });
      controller.hostUpdated();

      expect(shadowChildren).toHaveLength(3);
      expect(shadowRoot.adoptedStyleSheets).toEqual([adoptedStyle]);
      controller.unmount();
      expect(shadowChildren).toHaveLength(0);
      expect(shadowRoot.adoptedStyleSheets).toEqual([adoptedStyle]);
    } finally {
      if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });

  test("reconciles inputs and owns renderer completion and cleanup", () => {
    const htmlElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    class TestHTMLElement { readonly tagName = "DIV"; }
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: TestHTMLElement,
    });

    const controllers: ReactiveController[] = [];
    let updates = 0;
    const host: ReactiveControllerHost = {
      addController(controller) { controllers.push(controller); },
      removeController() {},
      requestUpdate() { updates += 1; },
      updateComplete: Promise.resolve(true),
    };
    const renders: number[] = [];
    let cleanups = 0;
    let complete: (() => void) | undefined;
    const controller = new PierreRenderer<Input, Renderer>(host, {
      create: (_input, rendered) => {
        complete = rendered;
        return { cleanUp: () => { cleanups += 1; } };
      },
      render: (_renderer, input) => renders.push(input.version),
      sameInput: (left, right) => left.version === right.version,
    });

    const binding = controller.bind({ version: 1 });
    const values = Reflect.get(binding, "values");
    const attach = Array.isArray(values) ? values[0] : null;
    if (typeof attach !== "function") throw new Error("Expected a ref binding");
    attach(new TestHTMLElement());

    expect(controllers).toEqual([controller]);
    expect(renders).toEqual([1]);
    expect(controller.rendered).toBe(false);

    complete?.();
    expect(controller.rendered).toBe(true);
    expect(updates).toBe(1);

    controller.bind({ version: 1 });
    controller.hostUpdated();
    expect(renders).toEqual([1]);

    controller.bind({ version: 2 });
    controller.hostUpdated();
    expect(renders).toEqual([1, 2]);
    expect(cleanups).toBe(1);

    controller.unmount();
    expect(cleanups).toBe(2);
    expect(controller.instance).toBeNull();

    if (htmlElementDescriptor) Object.defineProperty(globalThis, "HTMLElement", htmlElementDescriptor);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  });
});
