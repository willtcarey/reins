import { describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../../components/chat-panel.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { AgentMessage } from "../../models/chat-state.js";
import { templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function cacheSessionData(sessionCache: SessionCache, sessionId: string) {
  sessionCache.set(sessionId, {
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    activityState: null,
    messageCount: 0,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
    },
  });
}

function panelWithMessages(messages: AgentMessage[], sessionId = "sess-attachments") {
  const el = new ChatPanel();
  const cache = new ConversationsStore();
  const store = new ActiveSessionStore(sessionId, null, undefined, cache);
  cache.setPersistedMessages(sessionId, messages);
  el.store = store;
  return el;
}

describe("chat-panel attachment rendering", () => {
  test("renders user image attachments above text as size-preserving viewer buttons", () => {
    const el = panelWithMessages([
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "what do you see?" },
          {
            type: "image",
            attachmentId: "att_1",
            mimeType: "image/png",
            filename: "screen.png",
            byteSize: 123,
            width: 640,
            height: 480,
          },
        ],
      },
    ]);

    const output = templateToString(el.render());
    const attachmentsIndex = output.indexOf('data-role="user-message-attachments"');
    const bubbleIndex = output.indexOf('data-role="user-message-bubble"');
    const bubbleHtml = output.slice(bubbleIndex, output.indexOf("</div>", bubbleIndex));

    expect(attachmentsIndex).toBeGreaterThan(-1);
    expect(bubbleIndex).toBeGreaterThan(-1);
    expect(attachmentsIndex).toBeLessThan(bubbleIndex);
    expect(bubbleHtml).toContain("what do you see?");
    expect(bubbleHtml).not.toContain("<img");
    expect(output).toContain("Open image full screen");
    expect(output).toContain("<button");
    expect(output).toContain("screen.png");
    expect(output).toContain("/api/sessions/sess-attachments/attachments/att_1");
    expect(output).toContain("width=640");
    expect(output).toContain("height=480");
    expect(output).toContain("aspect-ratio: 640 / 480");
  });

  test("right-aligns attached image previews without centering them in a stretched object box", () => {
    const el = panelWithMessages([
      {
        role: "user",
        timestamp: 1,
        content: [
          {
            type: "image",
            attachmentId: "att_wide",
            mimeType: "image/png",
            filename: "wide-screen.png",
            byteSize: 123,
            width: 1600,
            height: 500,
          },
        ],
      },
    ]);

    const output = templateToString(el.render());

    expect(output).toContain("justify-items-end");
    expect(output).toContain("group ml-auto inline-flex max-w-full cursor-zoom-in justify-end");
    expect(output).toContain("block h-auto w-auto max-h-64 max-w-full");
    expect(output).not.toContain("object-contain");
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

    const client = new StubClient();
    client.prompt = prompt;
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "sess-1");
    const store = new ActiveSessionStore("sess-1", client, sessionCache);
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
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "sess-1");
    const store = new ActiveSessionStore("sess-1", client, sessionCache);
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
    expect(store.conversation.messages).toEqual([]);

    const messageKey = `user-${messages[0].timestamp}`;
    expect(Reflect.get(el, "isStreaming")).toBe(true);
    expect(templateToString(el.render())).toContain("Thinking...");
    expect(Reflect.get(el, "animatingUserMessageKeys")).toEqual(new Set([messageKey]));
    expect(runAnimation).toHaveBeenCalledWith(messageKey, origin);
    expect(prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);
  });
});
