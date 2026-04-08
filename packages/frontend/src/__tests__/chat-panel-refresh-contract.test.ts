import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../components/chat-panel.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { StubClient } from "./helpers/stub-client.js";

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") {
    throw new Error(`${key} is not callable`);
  }
  return Reflect.apply(fn, obj, args);
}

function connectStore(el: ChatPanel) {
  callPrivate(el, "subscribeToStore");
  callPrivate(el, "wireStoreEvents");
  callPrivate(el, "syncFromStore");
}

describe("ChatPanel refresh contract", () => {
  const originalRaf = globalThis.requestAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });

  test("sessionData refresh during a run preserves optimistic messages and streaming tool UI", () => {
    const immediateRaf: typeof globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    globalThis.requestAnimationFrame = immediateRaf;

    const client = new StubClient();
    client.prompt = mock(() => {});

    const store = new ActiveSessionStore(client);
    store.sessionId = "sess-1";

    const el = new ChatPanel();
    Reflect.set(el, "querySelector", () => null);
    el.store = store;
    connectStore(el);

    const initialSessionData = {
      id: "sess-1",
      task_id: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 1,
      },
    };

    store.sessionData = initialSessionData;
    callPrivate(store, "notify");

    store.sessionMessages = [
      { role: "user", content: "earlier prompt", timestamp: 100 },
    ];
    callPrivate(store, "notify");

    Reflect.set(el, "inputText", "new prompt");
    callPrivate(el, "handleSend");
    callPrivate(el, "handleAgentEvent", { type: "agent_start" });
    callPrivate(el, "handleAgentEvent", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const refreshedSessionData = {
      id: "sess-1",
      task_id: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: true,
        messageCount: 1,
      },
    };

    store.sessionData = refreshedSessionData;
    callPrivate(store, "notify");

    expect(Reflect.get(el, "messages")).toEqual([
      { role: "user", content: "earlier prompt", timestamp: 100 },
      { role: "user", content: "new prompt", timestamp: expect.any(Number) },
    ]);
    expect(Reflect.get(el, "isStreaming")).toBe(true);
    expect(Reflect.get(el, "streamingBlocks")).toEqual([
      {
        type: "tool",
        id: "tool-1",
        name: "bash",
        args: { command: "ls" },
        status: "running",
      },
    ]);

    const unsubscribeStore = Reflect.get(el, "unsubscribeStore");
    if (typeof unsubscribeStore === "function") unsubscribeStore();
    const unsubscribeEvent = Reflect.get(el, "unsubscribeEvent");
    if (typeof unsubscribeEvent === "function") unsubscribeEvent();
  });

  test("sessionMessages hydrate an empty panel after refresh even when the session is streaming", () => {
    const immediateRaf: typeof globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    globalThis.requestAnimationFrame = immediateRaf;

    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";

    const el = new ChatPanel();
    Reflect.set(el, "querySelector", () => null);
    el.store = store;
    connectStore(el);

    store.sessionData = {
      id: "sess-1",
      task_id: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: true,
        messageCount: 2,
      },
    };
    callPrivate(store, "notify");

    store.sessionMessages = [
      { role: "user", content: "hello", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2000,
      },
    ];
    callPrivate(store, "notify");

    expect(Reflect.get(el, "isStreaming")).toBe(true);
    expect(Reflect.get(el, "messages")).toEqual(store.sessionMessages);
  });

  test("disconnect unsubscribes from the store", () => {
    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";
    store.sessionData = {
      id: "sess-1",
      task_id: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 1,
      },
    };
    store.sessionMessages = [
      { role: "user", content: "before disconnect", timestamp: 100 },
    ];

    const el = new ChatPanel();
    Reflect.set(el, "querySelector", () => null);
    el.store = store;
    connectStore(el);

    expect(Reflect.get(el, "messages")).toEqual(store.sessionMessages);

    const unsubscribeStore = Reflect.get(el, "unsubscribeStore");
    if (typeof unsubscribeStore === "function") unsubscribeStore();
    Reflect.set(el, "unsubscribeStore", undefined);

    store.sessionMessages = [
      { role: "user", content: "after disconnect", timestamp: 200 },
    ];
    callPrivate(store, "notify");

    expect(Reflect.get(el, "messages")).toEqual([
      { role: "user", content: "before disconnect", timestamp: 100 },
    ]);
  });
});
