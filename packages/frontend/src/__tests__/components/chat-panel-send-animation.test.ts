import { describe, expect, mock, test } from "bun:test";
import { ChatPanel, computeConversationShiftDeltas, computeSendAnimationGeometry, computeSendAnimationStages } from "../../components/chat-panel.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

describe("conversation shift animation", () => {
  test("computes FLIP deltas so existing bubbles animate upward from their previous positions", () => {
    const deltas = computeConversationShiftDeltas(
      [
        { key: "user-1", left: 24, top: 420 },
        { key: "assistant-2", left: 16, top: 500 },
      ],
      [
        { key: "user-1", left: 24, top: 340 },
        { key: "assistant-2", left: 16, top: 420 },
        { key: "user-3", left: 180, top: 520 },
      ],
    );

    expect(deltas).toEqual([
      { key: "user-1", dx: 0, dy: 80 },
      { key: "assistant-2", dx: 0, dy: 80 },
    ]);
  });
});

describe("send animation geometry", () => {
  test("uses one continuous travel stage without a midpoint handoff", () => {
    const stages = computeSendAnimationStages({ dx: 220, dy: -200 });

    expect(Object.keys(stages).toSorted()).toEqual(["durationMs", "finalDx", "finalDy", "scale"].toSorted());
    expect(stages.finalDx).toBe(220);
    expect(stages.finalDy).toBe(-200);
    expect(stages.scale).toBe(1);
    expect(stages.durationMs).toBe(220);
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
  test("captures existing conversation positions before sending and animates them upward", () => {
    const el = new ChatPanel();
    const prompt = mock((_sessionId: string, _message: ClientPromptContent) => undefined);
    const snapshot = [{ key: "user-1", left: 24, top: 420 }];
    const runConversationShiftAnimation = mock(() => undefined);
    const origin = {
      rect: { left: 10, top: 20, width: 300, height: 44 },
      backgroundColor: "rgb(39, 39, 42)",
      borderRadius: "12px",
    };

    Reflect.set(el, "messages", [{ role: "user", content: "before", timestamp: 1 }]);

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
    Object.defineProperty(el, "captureConversationShiftSnapshot", { configurable: true, value: mock(() => snapshot) });
    Object.defineProperty(el, "runConversationShiftAnimation", { configurable: true, value: runConversationShiftAnimation });
    Object.defineProperty(el, "runOutgoingMessageAnimation", { configurable: true, value: mock(() => undefined) });

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "hello" }] } }));

    expect(runConversationShiftAnimation).toHaveBeenCalledWith(snapshot);
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

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "hello" }] } }));

    const messages = Reflect.get(el, "messages");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "hello" }] });

    const messageKey = `user-${messages[0].timestamp}`;
    expect(Reflect.get(el, "isStreaming")).toBe(true);
    expect(templateToString(el.render())).toContain("Thinking...");
    expect(Reflect.get(el, "animatingUserMessageKeys")).toEqual(new Set([messageKey]));
    expect(runAnimation).toHaveBeenCalledWith(messageKey, origin);
    expect(prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);
  });
});
