import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../components/chat-panel.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { StubClient } from "./helpers/stub-client.js";
import type { AgentMessage } from "../models/chat-state.js";

// ---- Helpers ----------------------------------------------------------------

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function get(obj: object, key: string) { return Reflect.get(obj, key); }

function makeSessionData(overrides: { isStreaming?: boolean; messageCount?: number } = {}) {
  return {
    id: "sess-1",
    task_id: null,
    activityState: null,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
      isStreaming: overrides.isStreaming ?? false,
      messageCount: overrides.messageCount ?? 0,
    },
  };
}

/** Create a wired-up ChatPanel + ActiveSessionStore pair. */
function setup(opts: { client?: StubClient } = {}) {
  const client = opts.client ?? new StubClient();
  const store = new ActiveSessionStore(client);
  store.sessionId = "sess-1";

  const el = new ChatPanel();
  Reflect.set(el, "querySelector", () => null);
  el.store = store;
  callPrivate(el, "subscribeToStore");
  callPrivate(el, "wireStoreEvents");
  callPrivate(el, "syncFromStore");

  return { el, store, client };
}

function cleanup(el: ChatPanel) {
  const unsub1 = get(el, "unsubscribeStore");
  if (typeof unsub1 === "function") unsub1();
  const unsub2 = get(el, "unsubscribeEvent");
  if (typeof unsub2 === "function") unsub2();
}

function notify(store: ActiveSessionStore) {
  callPrivate(store, "notify");
}

function fireEvent(el: ChatPanel, event: unknown) {
  callPrivate(el, "handleAgentEvent", event);
}

function startStreamingWithTool(el: ChatPanel) {
  fireEvent(el, { type: "agent_start" });
  fireEvent(el, {
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "ls" },
  });
}

// ---- Tests ------------------------------------------------------------------

describe("ChatPanel refresh contract", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  afterEach(() => { globalThis.requestAnimationFrame = originalRaf; });

  test("sessionData refresh during a run preserves optimistic messages and streaming tool UI", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });

    const client = new StubClient();
    client.prompt = mock(() => {});
    const { el, store } = setup({ client });

    store.sessionData = makeSessionData({ messageCount: 1 });
    notify(store);
    store.sessionMessages = [{ role: "user", content: "earlier prompt", timestamp: 100 }];
    notify(store);

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "new prompt" }] } }));
    startStreamingWithTool(el);

    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    notify(store);

    expect(get(el, "messages")).toEqual([
      { role: "user", content: "earlier prompt", timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: expect.any(Number) },
    ]);
    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingBlocks")).toHaveLength(1);

    cleanup(el);
  });

  test("sessionMessages hydrate an empty panel even when streaming", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store } = setup();

    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 2 });
    notify(store);

    store.sessionMessages = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
    ];
    notify(store);

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "messages")).toEqual(store.sessionMessages);
  });

  test("disconnect unsubscribes from the store", () => {
    const { el, store } = setup();

    store.sessionData = makeSessionData({ messageCount: 1 });
    store.sessionMessages = [{ role: "user", content: "before", timestamp: 100 }];
    notify(store);
    expect(get(el, "messages")).toEqual(store.sessionMessages);

    const unsub = get(el, "unsubscribeStore");
    if (typeof unsub === "function") unsub();
    Reflect.set(el, "unsubscribeStore", undefined);

    store.sessionMessages = [{ role: "user", content: "after", timestamp: 200 }];
    notify(store);

    expect(get(el, "messages")).toEqual([{ role: "user", content: "before", timestamp: 100 }]);
  });
});

describe("ChatPanel stale streaming reconciliation", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  afterEach(() => { globalThis.requestAnimationFrame = originalRaf; });

  test("clears streaming blocks when metadata transitions isStreaming to false", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store } = setup();

    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    notify(store);
    startStreamingWithTool(el);
    fireEvent(el, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Running..." } });

    expect(get(el, "streamingBlocks")).toHaveLength(2);

    // Metadata refresh after missed agent_end
    store.sessionData = makeSessionData({ messageCount: 3 });
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingBlocks")).toEqual([]);
    cleanup(el);
  });

  test("accepts persisted messages when metadata transitions isStreaming to false", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store } = setup();

    store.sessionMessages = [{ role: "user", content: "hello", timestamp: 1000 }];
    notify(store);

    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    notify(store);
    startStreamingWithTool(el);

    const finalMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Here are your files" }], timestamp: 2000 },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "file1.txt" }], isError: false, timestamp: 3000 },
    ];
    store.sessionMessages = finalMessages;
    store.sessionData = makeSessionData({ messageCount: 3 });
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingBlocks")).toEqual([]);
    expect(get(el, "messages")).toEqual(finalMessages);
    cleanup(el);
  });

  test("messages arriving before metadata are accepted once metadata catches up", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store } = setup();

    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    store.sessionMessages = [{ role: "user", content: "hello", timestamp: 1000 }];
    notify(store);
    startStreamingWithTool(el);

    // Messages arrive first, metadata still says streaming
    const finalMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
    ];
    store.sessionMessages = finalMessages;
    notify(store);

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingBlocks")).toHaveLength(1);

    // Metadata catches up
    store.sessionData = makeSessionData({ messageCount: 2 });
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingBlocks")).toEqual([]);
    expect(get(el, "messages")).toEqual(finalMessages);
    cleanup(el);
  });
});
