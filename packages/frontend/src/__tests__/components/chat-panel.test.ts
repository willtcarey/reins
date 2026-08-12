import { describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../../components/chat-panel.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { applyStreamingAssistant, setPersistedMessages } from "../helpers/conversations.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function cacheSessionData(cache: SessionCache, activityState: "running" | "finished" | null = null) {
  cache.set("sess-1", {
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    activityState,
    messageCount: 0,
    state: { model: null, thinkingLevel: "off" },
  });
}

function firstRepeatTemplate(panel: ChatPanel) {
  const directive = panel.render().values.find((value) => (
    typeof value === "object"
    && value !== null
    && Array.isArray(Reflect.get(value, "values"))
  ));
  const values = directive ? Reflect.get(directive, "values") : null;
  const messages = values?.[0];
  const renderMessage = values?.[2];
  if (!Array.isArray(messages) || typeof renderMessage !== "function") {
    throw new Error("Expected repeated messages");
  }
  return renderMessage(messages[0]);
}

describe("ChatPanel conversation orchestration", () => {
  test("passes domain messages and stable history identity to chat-message", () => {
    const conversations = new ConversationsStore();
    setPersistedMessages(conversations, "sess-1", [{ role: "user", content: "visible", timestamp: 1 }]);
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, undefined, conversations);

    const output = templateToString(firstRepeatTemplate(panel));

    expect(output).toContain("<chat-message");
    expect(output).toContain("data-conversation-key=1");
    expect(output).toContain("data-message-key=1");
    expect(output).toContain(".sessionId=sess-1");
  });

  test("renders previous-history loading at the conversation boundary", async () => {
    const panel = new ChatPanel();
    let finishLoad!: (loaded: boolean) => void;
    const loadEarlierMessages = mock(() => new Promise<boolean>((resolve) => { finishLoad = resolve; }));
    const container = {
      clientHeight: 600,
      scrollHeight: 1000,
      scrollTop: 20,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
      querySelectorAll: () => [],
    };
    Reflect.set(panel, "store", {
      conversation: { messages: [], streamingMessages: [], hasEarlierMessages: true, isCompacting: false, errorMessage: "" },
      sessionData: { activityState: null, state: {} },
      loadEarlierMessages,
    });
    Object.defineProperty(panel, "querySelector", { configurable: true, value: () => container });
    Object.defineProperty(panel, "updateComplete", { configurable: true, value: Promise.resolve(true) });

    const template = panel.render();
    const [click] = collectTemplateEventListeners(template, "click");
    const loading = click?.call(panel, new Event("click"));

    expect(loadEarlierMessages).toHaveBeenCalledWith();
    expect(templateToString(panel.render())).toContain("Loading previous messages…");
    finishLoad(false);
    await loading;
  });

  test("keeps streaming aggregate indicators in the panel", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "running");
    const conversations = new ConversationsStore();
    conversations.applyEvent("sess-1", {
      type: "message_update",
      message: { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "secret" }] },
      assistantMessageEvent: { type: "snapshot" },
    });
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, sessionCache, conversations);

    const thinking = templateToString(callPrivate(panel, "renderStreamingContent"));
    expect(thinking).toContain("Thinking...");
    expect(thinking).not.toContain("secret");

    conversations.applyEvent("sess-1", { type: "compaction_start" });
    const compacting = templateToString(callPrivate(panel, "renderStreamingContent"));
    expect(compacting).toContain("Summarizing conversation…");
    expect(compacting).not.toContain("Thinking...");
  });

  test("coordinates optimistic identity from composer submission", () => {
    const client = new StubClient();
    client.prompt = mock((_sessionId: string, _message: ClientPromptContent) => undefined);
    const conversations = new ConversationsStore();
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", client, undefined, conversations);

    callPrivate(panel, "handleSend", new CustomEvent("composer-submit", {
      detail: { content: [{ type: "text", text: "hello" }], source: null },
    }));

    const [message] = panel.store.conversation.messages;
    expect(message?.renderKey).toBe("live-1");
    expect(templateToString(firstRepeatTemplate(panel))).toContain("data-message-key=live-1");
    expect(client.prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);
  });

  test("renders live tool messages through the shared chat-message component", () => {
    const cache = new SessionCache();
    cacheSessionData(cache, "running");
    const conversations = new ConversationsStore();
    applyStreamingAssistant(conversations, "sess-1", [{ id: "tool-1", done: true }], 200);
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, cache, conversations);

    const streamingMessage = conversations.get("sess-1").streamingMessages[0];
    const output = templateToString(callPrivate(panel, "renderMessage", streamingMessage));
    expect(output).toContain("<chat-message");
    expect(output).toContain("streaming-assistant-200");
    expect(templateToString(callPrivate(panel, "renderStreamingContent"))).not.toContain("Thinking...");
  });
});

describe("ChatPanel mobile keyboard", () => {
  test("collapses the composer keyboard on message touch scroll", () => {
    const panel = new ChatPanel();
    const blurInput = mock(() => undefined);
    Object.defineProperty(panel, "composer", { configurable: true, value: { blurInput } });

    callPrivate(panel, "handleMessageTouchMove");

    expect(blurInput).toHaveBeenCalledTimes(1);
  });
});
