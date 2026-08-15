import { describe, expect, mock, test } from "bun:test";
import { PartType } from "lit/directive.js";
import {
  LongPressDirective,
  type LongPressOptions,
} from "../../directives/long-press.js";

class ElementStub extends EventTarget {
  style = { transform: "", willChange: "" };
  feedback: ElementStub | null = null;

  querySelector(selector: string) {
    return selector === "[data-feedback]" ? this.feedback : null;
  }
}

class TestLongPressDirective extends LongPressDirective {
  disconnect() {
    this.disconnected();
  }
}

function fakeTimers() {
  const callbacks = new Map<number, () => void>();
  const delays = new Map<number, number>();
  let nextId = 1;
  return {
    callbacks,
    delays,
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      callbacks.set(id, callback);
      delays.set(id, delay);
      return id;
    },
    clearTimeout(id: number) {
      callbacks.delete(id);
      delays.delete(id);
    },
    run(delay: number) {
      const timer = [...delays].find(([, value]) => value === delay);
      if (!timer) throw new Error(`Expected a ${delay}ms timer`);
      const [id] = timer;
      const callback = callbacks.get(id);
      callbacks.delete(id);
      delays.delete(id);
      callback?.();
    },
  };
}

function pointerEvent(
  type: string,
  fields: Partial<PointerEvent> & Pick<PointerEvent, "pointerId" | "pointerType" | "clientX" | "clientY">,
) {
  const event = new Event(type);
  Object.defineProperties(event, {
    isPrimary: { value: true },
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])),
  });
  return event;
}

function attach(
  directive: LongPressDirective,
  element: ElementStub,
  options: LongPressOptions,
) {
  Reflect.apply(directive.update, directive, [{ type: PartType.ELEMENT, element }, [options]]);
}

describe("longPress", () => {
  test("recognizes only a stationary primary touch and keeps resolved feedback pressed until async completion", async () => {
    const timers = fakeTimers();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalWindow = globalThis.window;
    Object.assign(globalThis, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      window: {
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame: mock(() => 1),
        cancelAnimationFrame: mock(() => undefined),
      },
    });

    let dismiss: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => { dismiss = resolve; });
    const onComplete = mock(() => completion);
    const root = new ElementStub();
    const feedback = new ElementStub();
    root.feedback = feedback;
    const directive = new TestLongPressDirective({ type: PartType.ELEMENT });

    try {
      attach(directive, root, { feedback: "[data-feedback]", onComplete });
      root.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 5,
        pointerType: "mouse",
        clientX: 20,
        clientY: 30,
      }));
      root.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 6,
        pointerType: "touch",
        isPrimary: false,
        clientX: 20,
        clientY: 30,
      }));
      expect(timers.callbacks.size).toBe(0);

      const down = pointerEvent("pointerdown", {
        pointerId: 7,
        pointerType: "touch",
        clientX: 20,
        clientY: 30,
      });
      const preventDefault = mock(() => undefined);
      Object.defineProperty(down, "preventDefault", { value: preventDefault });
      root.dispatchEvent(down);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(feedback.style.transform).toBe("");

      timers.run(650);
      expect(feedback.style.transform).toBe("scale(0.97)");

      root.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 8,
        pointerType: "touch",
        clientX: 20,
        clientY: 30,
      }));
      timers.run(900);

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(feedback.style.transform).toBe("scale(0.97)");

      root.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 7,
        pointerType: "touch",
        clientX: 20,
        clientY: 30,
      }));
      expect(feedback.style.transform).toBe("scale(0.97)");

      dismiss?.();
      await completion;
      await Promise.resolve();
      expect(feedback.style.transform).toBe("");
    } finally {
      directive.disconnect();
      Object.assign(globalThis, {
        setTimeout: originalSetTimeout,
        clearTimeout: originalClearTimeout,
        window: originalWindow,
      });
    }
  });

  test("movement, pointer cancellation, and directive disconnection cancel pending completion", () => {
    const timers = fakeTimers();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalWindow = globalThis.window;
    Object.assign(globalThis, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      window: { matchMedia: () => ({ matches: true }) },
    });
    const onComplete = mock(() => undefined);
    const root = new ElementStub();
    root.feedback = new ElementStub();
    const directive = new TestLongPressDirective({ type: PartType.ELEMENT });

    try {
      attach(directive, root, { feedback: "[data-feedback]", onComplete });
      root.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      }));
      root.dispatchEvent(pointerEvent("pointermove", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 11,
        clientY: 0,
      }));
      expect(timers.callbacks.size).toBe(0);
      expect(root.feedback.style.transform).toBe("");
      expect(root.feedback.style.willChange).toBe("");

      root.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 2,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      }));
      root.dispatchEvent(pointerEvent("pointercancel", {
        pointerId: 2,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      }));
      expect(timers.callbacks.size).toBe(0);

      root.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 3,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      }));
      directive.disconnect();
      expect(timers.callbacks.size).toBe(0);
      expect(root.feedback.style.transform).toBe("");

      root.dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 4,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      }));
      expect(timers.callbacks.size).toBe(0);
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      directive.disconnect();
      Object.assign(globalThis, {
        setTimeout: originalSetTimeout,
        clearTimeout: originalClearTimeout,
        window: originalWindow,
      });
    }
  });
});
