import { describe, expect, test } from "bun:test";
import { Spring } from "../../models/spring.js";

describe("Spring", () => {
  test("animates a value to its target and settles", () => {
    const originalWindow = globalThis.window;
    const frameCallbacks: FrameRequestCallback[] = [];
    const values: number[] = [];
    let settled = false;

    Reflect.set(globalThis, "window", {
      requestAnimationFrame(callback: FrameRequestCallback) {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame() {},
    });

    try {
      new Spring({
        value: -610,
        target: -780,
        velocity: -1.2,
        onUpdate: (value) => values.push(value),
        onSettle: () => { settled = true; },
      });

      expect(values).toEqual([-610]);
      expect(settled).toBe(false);

      frameCallbacks[0](0);
      expect(values.length).toBeGreaterThan(1);
      expect(values.at(-1)).toBeLessThan(-610);

      for (let index = 1; index < frameCallbacks.length; index += 1) {
        frameCallbacks[index](index * 16);
        if (settled) break;
      }

      expect(values[7]).toBeGreaterThanOrEqual(-780);
      expect(settled).toBe(true);
      expect(Math.round(values.at(-1) ?? 0)).toBe(-780);
      expect(values.some((value) => value < -610 && value > -780)).toBe(true);
      expect(values.some((value) => value < -780)).toBe(true);
    } finally {
      Reflect.set(globalThis, "window", originalWindow);
    }
  });

  test("supports per-instance physics while defaulting to the shared spring behavior", () => {
    const originalWindow = globalThis.window;
    const frameCallbacks: FrameRequestCallback[] = [];
    const defaultValues: number[] = [];
    const softValues: number[] = [];

    Reflect.set(globalThis, "window", {
      requestAnimationFrame(callback: FrameRequestCallback) {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame() {},
    });

    try {
      new Spring({
        value: 100,
        target: 0,
        velocity: 0,
        onUpdate: (value) => defaultValues.push(value),
        onSettle() {},
      });
      new Spring({
        value: 100,
        target: 0,
        velocity: 0,
        stiffness: 0.000218295,
        damping: 0.019026,
        onUpdate: (value) => softValues.push(value),
        onSettle() {},
      });

      frameCallbacks[0](0);
      frameCallbacks[1](0);
      frameCallbacks[2](16);
      frameCallbacks[3](16);

      expect(defaultValues[1]).toBeCloseTo(85.92);
      expect(softValues.at(-1)).toBeGreaterThan(defaultValues.at(-1) ?? 0);
      expect(softValues.at(-1)).toBeLessThan(100);
    } finally {
      Reflect.set(globalThis, "window", originalWindow);
    }
  });

  test("cancels an in-flight animation", () => {
    const originalWindow = globalThis.window;
    const canceledFrame: { value: number | null } = { value: null };
    let settled = false;

    Reflect.set(globalThis, "window", {
      requestAnimationFrame() { return 42; },
      cancelAnimationFrame(frame: number) { canceledFrame.value = frame; },
    });

    try {
      const spring = new Spring({
        value: 0,
        target: -390,
        velocity: 0,
        onUpdate() {},
        onSettle: () => { settled = true; },
      });

      spring.cancel();

      expect(canceledFrame.value).toBe(42);
      expect(settled).toBe(false);
    } finally {
      Reflect.set(globalThis, "window", originalWindow);
    }
  });
});
