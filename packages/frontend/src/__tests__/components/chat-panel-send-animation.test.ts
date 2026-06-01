import { describe, expect, mock, test } from "bun:test";
import { ChatPanel, computeSendAnimationGeometry, computeSendAnimationStages } from "../../components/chat-panel.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function ElementWithoutAnimate() {}

describe("send animation geometry", () => {
  test("starts with a small detaching drift toward the final bubble", () => {
    const stages = computeSendAnimationStages({ dx: 220, dy: -200 });

    expect(stages.detachDx).toBe(18);
    expect(stages.detachDy).toBe(-14);
    expect(stages.finalDx).toBe(220);
    expect(stages.finalDy).toBe(-200);
    expect(stages.detachScale).toBeGreaterThan(1);
    expect(stages.travelScale).toBeGreaterThan(stages.settleScale);
  });

  test("starts short prompts at bubble width while staying anchored to the prompt start", () => {
    const geometry = computeSendAnimationGeometry(
      { left: 100, top: 400, width: 300, height: 44 },
      { left: 320, top: 200, width: 80, height: 32 },
      { left: 0, top: 0, width: 400, height: 700 },
    );

    expect(geometry.startWidth).toBe(80);
    expect(geometry.startLeft).toBe(100);
    expect(geometry.dx).toBe(220);
  });

  test("caps the starting width at the composer width for long prompts", () => {
    const geometry = computeSendAnimationGeometry(
      { left: 100, top: 400, width: 220, height: 44 },
      { left: 40, top: 200, width: 280, height: 72 },
      { left: 0, top: 0, width: 400, height: 700 },
    );

    expect(geometry.startWidth).toBe(220);
    expect(geometry.startLeft).toBe(100);
    expect(geometry.dx).toBe(-60);
  });
});

describe("ChatPanel mobile keyboard", () => {
  test("wires message touch scroll to collapse the mobile keyboard", () => {
    const el = new ChatPanel();

    const output = templateToString(el.render());
    const scrollStart = output.indexOf('id="chat-scroll"');
    const scrollEnd = output.indexOf(">", scrollStart);
    const scrollTag = output.slice(scrollStart, scrollEnd);

    expect(scrollTag).toContain("@touchmove=");
  });

  test("collapses the composer keyboard on message touch scroll", () => {
    const el = new ChatPanel();
    const blurInput = mock(() => undefined);
    Object.defineProperty(el, "composer", {
      configurable: true,
      value: { blurInput },
    });

    callPrivate(el, "handleMessageTouchMove");

    expect(blurInput).toHaveBeenCalledTimes(1);
  });
});


describe("ChatPanel send animation", () => {
  test("renders a local layer for outgoing message animations", () => {
    const el = new ChatPanel();

    const output = templateToString(el.render());

    expect(output).toContain('data-role="send-animation-layer"');
  });

  test("renders outgoing user messages with animation hooks and hidden state", () => {
    const el = new ChatPanel();
    Reflect.set(el, "messages", [{ role: "user", content: "hello", timestamp: 123 }]);
    Reflect.set(el, "animatingUserMessageKeys", new Set(["user-123"]));

    const output = templateToString(el.render());

    expect(output).toContain('data-role="user-message-row"');
    expect(output).toContain("data-message-key=user-123");
    expect(output).toContain('data-role="user-message-bubble"');
    expect(output).toContain("sent-message-target-hidden");
  });

  test("does not require the Web Animations API to attempt the send animation", () => {
    const el = new ChatPanel();
    const originalDocument = globalThis.document;
    const originalElement = globalThis.Element;

    try {
      const body = {};
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { body },
      });
      Object.defineProperty(globalThis, "Element", {
        configurable: true,
        value: ElementWithoutAnimate,
      });

      expect(callPrivate(el, "canAnimateOutgoingMessage")).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
      Object.defineProperty(globalThis, "Element", {
        configurable: true,
        value: originalElement,
      });
    }
  });

  test("captures the composer origin before sending and animates the optimistic bubble", () => {
    const el = new ChatPanel();
    const prompt = mock((_sessionId: string, _message: ClientPromptContent) => undefined);
    const runAnimation = mock(() => undefined);
    const origin = {
      rect: { left: 10, top: 20, width: 300, height: 44 },
      backgroundColor: "rgb(39, 39, 42)",
      borderRadius: "12px",
    };

    const client = new StubClient();
    client.prompt = prompt;
    const store = new ActiveSessionStore(client);
    store.sessionId = "sess-1";
    el.store = store;

    Object.defineProperty(el, "composer", {
      configurable: true,
      value: {
        getSendAnimationOrigin: () => origin,
        closeSuggestions: mock(() => undefined),
      },
    });
    Object.defineProperty(el, "canAnimateOutgoingMessage", { configurable: true, value: () => true });
    Object.defineProperty(el, "runOutgoingMessageAnimation", { configurable: true, value: runAnimation });

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: "hello" } }));

    const messages = Reflect.get(el, "messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "hello" });

    const messageKey = `user-${messages[0].timestamp}`;
    expect(Reflect.get(el, "isStreaming")).toBe(true);
    expect(templateToString(el.render())).toContain("Thinking...");
    expect(Reflect.get(el, "animatingUserMessageKeys")).toEqual(new Set([messageKey]));
    expect(runAnimation).toHaveBeenCalledWith(messageKey, origin);
    expect(prompt).toHaveBeenCalledWith("sess-1", "hello");
  });
});
