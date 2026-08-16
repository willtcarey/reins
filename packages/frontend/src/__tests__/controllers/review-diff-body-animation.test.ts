import { afterEach, describe, expect, test } from "bun:test";
import type { ReactiveControllerHost } from "lit";
import { ReviewDiffBodyAnimation } from "../../controllers/review-diff-body-animation.js";

const originalWindow = globalThis.window;

afterEach(() => {
  Reflect.set(globalThis, "window", originalWindow);
});

function fakeHost() {
  let updates = 0;
  const host: ReactiveControllerHost = {
    addController() {},
    removeController() {},
    requestUpdate() { updates += 1; },
    updateComplete: Promise.resolve(true),
  };
  return { host, updates: () => updates };
}

function installAnimationWindow(reducedMotion = false) {
  const frames: FrameRequestCallback[] = [];
  const canceled = new Set<number>();
  Reflect.set(globalThis, "window", {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame(id: number) { canceled.add(id); },
  });
  return {
    frames,
    runUntilSettled(limit = 500) {
      for (let index = 0; index < frames.length && index < limit; index += 1) {
        if (!canceled.has(index + 1)) frames[index]?.(index * 16);
      }
    },
  };
}

const body = (height: number) => ({ scrollHeight: height });

describe("ReviewDiffBodyAnimation", () => {
  test("retains the mounted body while collapsing and removes it after settling", () => {
    const animationWindow = installAnimationWindow();
    const { host } = fakeHost();
    const animation = new ReviewDiffBodyAnimation(host);

    animation.sync(false);
    animation.sync(true);
    animation.bodyReady(body(240));

    expect(animation.renderBody).toBe(true);
    expect(animation.height).toBe(240);

    animationWindow.runUntilSettled();

    expect(animation.renderBody).toBe(false);
    expect(animation.height).toBeNull();
  });

  test("mounts an expanding body at zero and clears its height after settling", () => {
    const animationWindow = installAnimationWindow();
    const { host } = fakeHost();
    const animation = new ReviewDiffBodyAnimation(host);

    animation.sync(true);
    animation.sync(false);

    expect(animation.renderBody).toBe(true);
    expect(animation.height).toBe(0);

    animation.bodyReady(body(180));
    animationWindow.runUntilSettled();

    expect(animation.renderBody).toBe(true);
    expect(animation.height).toBeNull();
  });

  test("reverses an in-flight collapse and keeps rendered heights bounded", () => {
    const animationWindow = installAnimationWindow();
    const { host } = fakeHost();
    const animation = new ReviewDiffBodyAnimation(host);

    animation.sync(false);
    animation.sync(true);
    animation.bodyReady(body(200));
    animationWindow.frames[0]?.(0);
    animationWindow.frames[1]?.(16);
    const collapsingHeight = animation.height!;

    animation.sync(false);
    animation.bodyReady(body(200));
    animationWindow.runUntilSettled();

    expect(collapsingHeight).toBeGreaterThanOrEqual(0);
    expect(collapsingHeight).toBeLessThanOrEqual(200);
    expect(animation.renderBody).toBe(true);
    expect(animation.height).toBeNull();
  });

  test("settles immediately when reduced motion is preferred", () => {
    installAnimationWindow(true);
    const { host } = fakeHost();
    const animation = new ReviewDiffBodyAnimation(host);

    animation.sync(false);
    animation.sync(true);
    animation.bodyReady(body(120));

    expect(animation.renderBody).toBe(false);
    expect(animation.height).toBeNull();
  });
});
