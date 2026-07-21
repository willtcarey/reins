import { describe, expect, test } from "bun:test";
import {
  ChatSendAnimator,
  type ChatSendAnimationHost,
} from "../../helpers/chat-send-animation.js";

describe("ChatSendAnimator", () => {
  test("is the module's only runtime operation", async () => {
    const animationModule = await import("../../helpers/chat-send-animation.js");
    expect(animationModule.ChatSendAnimator).toBe(ChatSendAnimator);
    expect(Object.keys(animationModule)).toEqual(["ChatSendAnimator"]);
  });

  test("springs the conversation to the bottom with the outgoing message", async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const frames: FrameRequestCallback[] = [];

    const queryResults = new WeakMap<object, object>();
    class HTMLElementStub {
      style: Record<string, string> = {};
      classList = { add() {}, remove() {} };
      scrollTop = 100;
      scrollHeight = 700;
      clientHeight = 400;
      setAttribute() {}
      appendChild() {}
      remove() {}
      cloneNode() { return new HTMLElementStub(); }
      querySelector() { return queryResults.get(this) ?? null; }
      getBoundingClientRect() {
        return { left: 200, top: 500, width: 120, height: 36 };
      }
    }

    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElementStub });
    const destination = new HTMLElement();
    const row = new HTMLElement();
    queryResults.set(row, destination);
    const scroll = new HTMLElement();
    const body = new HTMLElement();
    const fakeWindow = Object.assign(new EventTarget(), {
      matchMedia: () => ({ matches: false }),
      visualViewport: null,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame: () => undefined,
    });

    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { body } });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    try {
      const querySelector: ChatSendAnimationHost["querySelector"] = (selector: string) => (
        selector === "#chat-scroll" ? scroll : row
      );
      const animator = new ChatSendAnimator({
        updateComplete: Promise.resolve(),
        querySelector,
      });
      const animation = animator.animate(
        "local-1",
        { rect: { left: 20, top: 600, width: 300, height: 44 } },
        () => undefined,
      );

      await Promise.resolve();
      expect(animator.scrollLocked).toBe(true);
      expect(scroll.scrollTop).toBe(100);

      frames.shift()?.(0);
      await Promise.resolve();
      frames.shift()?.(16);
      expect(scroll.scrollTop).toBeGreaterThan(100);
      expect(scroll.scrollTop).toBeLessThan(300);

      let time = 32;
      while (frames.length > 0 && time < 10_000) {
        frames.shift()?.(time);
        time += 16;
      }
      expect(await animation).toBe(true);
      expect(scroll.scrollTop).toBe(300);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
      else Reflect.deleteProperty(globalThis, "document");
      if (elementDescriptor) Object.defineProperty(globalThis, "HTMLElement", elementDescriptor);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
      if (frameDescriptor) Object.defineProperty(globalThis, "requestAnimationFrame", frameDescriptor);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
  });
});
