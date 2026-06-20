import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../components/chat-panel.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { ConversationsStore } from "../models/stores/conversations-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { StubClient } from "./helpers/stub-client.js";
import type { AgentMessage } from "../models/chat-state.js";

// ---- Helpers ----------------------------------------------------------------

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function get(obj: object, key: string) { return Reflect.get(obj, key); }

function makeSessionData(overrides: { activityState?: "running" | "finished" | null; messageCount?: number } = {}) {
  return {
    id: "sess-1",
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    messageCount: overrides.messageCount ?? 0,
    activityState: overrides.activityState ?? null,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
      messageCount: overrides.messageCount ?? 0,
    },
  };
}

function setSessionData(store: ActiveSessionStore, data: ReturnType<typeof makeSessionData>) {
  sessionCaches.get(store)?.set(data.id, data);
}

const sessionCaches = new WeakMap<ActiveSessionStore, SessionCache>();

/** Create a wired-up ChatPanel + ActiveSessionStore pair. */
function setup(opts: { client?: StubClient } = {}) {
  const client = opts.client ?? new StubClient();
  const sessionCache = new SessionCache();
  const conversationsStore = new ConversationsStore();
  const store = new ActiveSessionStore("sess-1", client, sessionCache, conversationsStore);
  sessionCaches.set(store, sessionCache);

  const el = new ChatPanel();
  Reflect.set(el, "querySelector", () => null);
  el.store = store;
  callPrivate(el, "subscribeToStore");

  return { el, store, client, conversationsStore };
}

function cleanup(el: ChatPanel) {
  const unsub1 = get(el, "unsubscribeStore");
  if (typeof unsub1 === "function") unsub1();
}

function notify(store: ActiveSessionStore) {
  void callPrivate(store, "handleSessionCacheUpdate");
  callPrivate(store, "notify");
}

function startStreamingWithTool(conversationsStore: ConversationsStore) {
  conversationsStore.applyEvent("sess-1", { type: "agent_start" });
  conversationsStore.applyEvent("sess-1", {
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
    const { el, store, conversationsStore } = setup({ client });

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    notify(store);
    conversationsStore.setPersistedMessages("sess-1", [{ role: "user", content: "earlier prompt", timestamp: 100 }]);

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "new prompt" }] } }));
    startStreamingWithTool(conversationsStore);

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);

    expect(get(el, "messages")).toEqual([
      { role: "user", content: "earlier prompt", timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: expect.any(Number) },
    ]);
    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingBlocks")).toHaveLength(1);

    cleanup(el);
  });

  test("stale persisted messages do not drop an optimistic user message", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });

    const client = new StubClient();
    client.prompt = mock(() => {});
    const { el, store, conversationsStore } = setup({ client });
    const persisted: AgentMessage[] = [{ role: "user", content: "earlier prompt", timestamp: 100 }];

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    conversationsStore.setPersistedMessages("sess-1", persisted);
    notify(store);

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "new prompt" }] } }));

    // A quick metadata/messages refresh can still reflect the DB state before
    // the just-sent prompt has been committed. The UI should layer the local
    // optimistic user message on top of that stale persisted snapshot.
    setSessionData(store, makeSessionData({ messageCount: 1 }));
    conversationsStore.setPersistedMessages("sess-1", [...persisted]);
    notify(store);

    expect(get(el, "messages")).toEqual([
      { role: "user", content: "earlier prompt", timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: expect.any(Number) },
    ]);

    cleanup(el);
  });

  test("persisted conversation messages hydrate an empty panel even when streaming", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setup();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 2 }));
    notify(store);

    conversationsStore.setPersistedMessages("sess-1", [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
    ]);

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "messages")).toEqual(store.conversation.persistedMessages);
  });

  test("disconnect unsubscribes from store render notifications", () => {
    const { el, store, conversationsStore } = setup();

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    conversationsStore.setPersistedMessages("sess-1", [{ role: "user", content: "before", timestamp: 100 }]);
    notify(store);
    expect(get(el, "messages")).toEqual(store.conversation.persistedMessages);

    const requestUpdate = mock(() => undefined);
    Reflect.set(el, "requestUpdate", requestUpdate);

    const unsub = get(el, "unsubscribeStore");
    if (typeof unsub === "function") unsub();
    Reflect.set(el, "unsubscribeStore", undefined);

    conversationsStore.setPersistedMessages("sess-1", [{ role: "user", content: "after", timestamp: 200 }]);
    notify(store);

    expect(requestUpdate).not.toHaveBeenCalled();
  });
});

describe("ChatPanel stale streaming reconciliation", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  afterEach(() => { globalThis.requestAnimationFrame = originalRaf; });

  test("clears streaming blocks when metadata transitions activityState from running", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setup();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);
    startStreamingWithTool(conversationsStore);
    conversationsStore.applyEvent("sess-1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Running..." } });

    expect(get(el, "streamingBlocks")).toHaveLength(2);

    // Metadata refresh after missed agent_end
    setSessionData(store, makeSessionData({ messageCount: 3 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingBlocks")).toEqual([]);
    cleanup(el);
  });

  test("accepts persisted messages when metadata transitions activityState from running", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setup();

    conversationsStore.setPersistedMessages("sess-1", [{ role: "user", content: "hello", timestamp: 1000 }]);
    notify(store);

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);
    startStreamingWithTool(conversationsStore);

    const finalMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Here are your files" }], timestamp: 2000 },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "file1.txt" }], isError: false, timestamp: 3000 },
    ];
    conversationsStore.setPersistedMessages("sess-1", finalMessages);
    setSessionData(store, makeSessionData({ messageCount: 3 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingBlocks")).toEqual([]);
    expect(get(el, "messages")).toEqual(finalMessages);
    cleanup(el);
  });

  test("messages arriving before metadata are accepted once metadata catches up", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setup();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    conversationsStore.setPersistedMessages("sess-1", [{ role: "user", content: "hello", timestamp: 1000 }]);
    notify(store);
    startStreamingWithTool(conversationsStore);

    // Messages arrive first, metadata still says running
    const finalMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
    ];
    conversationsStore.setPersistedMessages("sess-1", finalMessages);
    notify(store);

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingBlocks")).toHaveLength(1);

    // Metadata catches up
    setSessionData(store, makeSessionData({ messageCount: 2 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingBlocks")).toEqual([]);
    expect(get(el, "messages")).toEqual(finalMessages);
    cleanup(el);
  });
});
