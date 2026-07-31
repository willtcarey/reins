import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../../components/chat-panel.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { AgentMessage } from "../../models/chat-state.js";
import {
  applyStreamingAssistant,
  completedToolTurn,
  setPersistedMessages,
} from "../helpers/conversations.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

function isDirectiveResult(value: unknown): value is { values: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "values"));
}

function renderConversationEntry(el: ChatPanel, index = 0): string {
  const messageDirective = el.render().values.find(isDirectiveResult);
  const entries = messageDirective?.values[0];
  const renderEntry = messageDirective?.values[2];
  if (!Array.isArray(entries) || typeof renderEntry !== "function") {
    throw new Error("Expected rendered conversation entries");
  }
  return templateToString(renderEntry(entries[index]));
}

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function cacheSessionData(
  sessionCache: SessionCache,
  sessionId: string,
  activityState: "running" | "finished" | null = null,
) {
  sessionCache.set(sessionId, {
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    activityState,
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
  setPersistedMessages(cache, sessionId, messages);
  el.store = store;
  return el;
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

const sessionCaches = new WeakMap<ActiveSessionStore, SessionCache>();

function setupPanel(opts: { client?: StubClient } = {}) {
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

function setSessionData(store: ActiveSessionStore, data: ReturnType<typeof makeSessionData>) {
  sessionCaches.get(store)?.set(data.id, data);
}

function notify(store: ActiveSessionStore) {
  void callPrivate(store, "handleSessionCacheUpdate");
  callPrivate(store, "notify");
}

function cleanupPanel(el: ChatPanel) {
  const unsubscribe = get(el, "unsubscribeStore");
  if (typeof unsubscribe === "function") unsubscribe();
}

function startStreamingWithTool(
  conversationsStore: ConversationsStore,
  messageTimestamp = 100,
) {
  applyStreamingAssistant(conversationsStore, "sess-1", [
    { id: "tool-1", name: "bash", arguments: { command: "ls" } },
  ], messageTimestamp);
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

    const output = renderConversationEntry(el);
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

    const output = renderConversationEntry(el);

    expect(output).toContain("justify-items-end");
    expect(output).toContain("group ml-auto inline-flex max-w-full cursor-zoom-in justify-end");
    expect(output).toContain("block h-auto w-auto max-h-64 max-w-full");
    expect(output).not.toContain("object-contain");
  });
});


describe("ChatPanel session switching", () => {
  test("resubscribes and clears ephemeral state when the store changes", () => {
    const el = new ChatPanel();
    const unsubscribeOld = mock(() => undefined);
    const unsubscribeNew = mock(() => undefined);
    const oldMessage: AgentMessage = { role: "user", content: [{ type: "text", text: "old session message" }], timestamp: 1 };
    const newMessage: AgentMessage = { role: "user", content: [{ type: "text", text: "new session message" }], timestamp: 2 };
    const oldStore = {
      sessionId: "sess-old",
      conversation: {
        entries: [{ id: "old-message", parentId: null, message: oldMessage }],
        messages: [oldMessage],
        hasEarlierMessages: false,
        streamingAssistants: [],
        isCompacting: false,
        errorMessage: "",
      },
      sessionData: { activityState: null, state: {} },
      subscribe: mock(() => unsubscribeOld),
    };
    const newStore = {
      sessionId: "sess-new",
      conversation: {
        entries: [{ id: "new-message", parentId: null, message: newMessage }],
        messages: [newMessage],
        hasEarlierMessages: false,
        streamingAssistants: [],
        isCompacting: false,
        errorMessage: "",
      },
      sessionData: { activityState: null, state: {} },
      subscribe: mock(() => unsubscribeNew),
    };

    Reflect.set(el, "store", oldStore);
    Reflect.get(el, "subscribeToStore").call(el);
    Reflect.set(el, "expandedSections", new Set(["tool-1"]));

    Reflect.set(el, "store", newStore);
    callPrivate(el, "willUpdate", new Map<string, unknown>([["store", oldStore]]));

    expect(unsubscribeOld).toHaveBeenCalledTimes(1);
    expect(newStore.subscribe).toHaveBeenCalledTimes(1);
    expect(renderConversationEntry(el)).toContain("new session message");
    expect(Reflect.get(el, "expandedSections")).toEqual(new Set());
  });
});


describe("ChatPanel streaming reconciliation rendering", () => {
  test("renders a canonical completed tool once with its final response while activity metadata is still running", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "sess-1", "running");
    const conversations = new ConversationsStore();
    const el = new ChatPanel();
    el.store = new ActiveSessionStore("sess-1", null, sessionCache, conversations);
    const prompt = [{ type: "text" as const, text: "Push that" }];

    conversations.addOptimisticUserMessage("sess-1", prompt, 100);
    const tool = { id: "tool-1", name: "search", arguments: { query: "git push" }, result: "pushed" };
    applyStreamingAssistant(conversations, "sess-1", [{ ...tool, done: true }], 200);

    const canonicalMessages: AgentMessage[] = [
      { role: "user", content: prompt, timestamp: 100 },
      ...completedToolTurn([tool], "Pushed successfully.", 200),
    ];
    setPersistedMessages(conversations, "sess-1", canonicalMessages);

    const toolOutput = renderConversationEntry(el, 1);
    expect(toolOutput.match(/search-tool-block/g)).toHaveLength(2);
    expect(toolOutput).toContain("pushed");
    expect(renderConversationEntry(el, 3)).toContain("Pushed successfully.");
    expect(templateToString(el.render())).not.toContain("search-tool-block");
  });

  test("renders live text and tools in native assistant order with matching overlays", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "sess-1", "running");
    const conversations = new ConversationsStore();
    const el = new ChatPanel();
    el.store = new ActiveSessionStore("sess-1", null, sessionCache, conversations);

    applyStreamingAssistant(conversations, "sess-1", [
      "before",
      { id: "tool-1", name: "search", arguments: { query: "needle" }, result: "found", done: true },
      "after",
    ], 200);

    const output = templateToString(callPrivate(el, "renderStreamingContent"));
    const before = output.indexOf("before");
    const tool = output.indexOf("search-tool-block");
    const after = output.indexOf("after");
    expect(before).toBeGreaterThan(-1);
    expect(tool).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(tool);
    expect(output).toContain("found");
    expect(output).toContain("streaming=true");
  });

  test("waits for tool execution before rendering partial streamed tool arguments", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "sess-1", "running");
    const conversations = new ConversationsStore();
    const el = new ChatPanel();
    el.store = new ActiveSessionStore("sess-1", null, sessionCache, conversations);

    conversations.applyEvent("sess-1", {
      type: "message_update",
      message: {
        role: "assistant",
        timestamp: 200,
        content: [{
          type: "toolCall",
          id: "write-1",
          name: "write",
          arguments: { path: "src/file.ts", content: "const html = <di" },
        }],
      },
      assistantMessageEvent: { type: "toolcall_delta" },
    });

    expect(templateToString(callPrivate(el, "renderStreamingContent"))).not.toContain("write-tool-block");

    conversations.applyEvent("sess-1", {
      type: "message_update",
      message: {
        role: "assistant",
        timestamp: 200,
        content: [{
          type: "toolCall",
          id: "write-1",
          name: "write",
          arguments: { path: "src/file.ts", content: "const html = <div></div>;" },
        }],
      },
      assistantMessageEvent: { type: "toolcall_end" },
    });
    conversations.applyEvent("sess-1", {
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "src/file.ts", content: "const html = <div></div>;" },
    });

    const rendered = templateToString(callPrivate(el, "renderStreamingContent"));
    expect(rendered).toContain("write-tool-block");
    expect(rendered).toContain("const html = <div></div>;");
  });

  test("uses the shared assistant renderer for persisted and live snapshots", () => {
    const message = {
      role: "assistant" as const,
      timestamp: 200,
      content: [{ type: "text" as const, text: "same markdown" }],
    };
    const el = panelWithMessages([message]);
    const persisted = renderConversationEntry(el);
    const live = templateToString(callPrivate(el, "renderAssistantMessage", message, "live", { streaming: true }));

    expect(persisted).toContain("bg-zinc-800 border-l-2 border-blue-400/60");
    expect(live).toContain("bg-zinc-800 border-l-2 border-blue-400/60");
    expect(persisted).toContain(".streaming=");
    expect(persisted).not.toContain("streaming=true");
    expect(live).toContain("streaming=true");
  });

  test("shows thinking while received assistant snapshots contain only hidden thinking", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "sess-1", "running");
    const conversations = new ConversationsStore();
    conversations.applyEvent("sess-1", {
      type: "message_update",
      message: { role: "assistant", timestamp: 200, content: [{ type: "thinking", thinking: "secret" }] },
      assistantMessageEvent: { type: "snapshot" },
    });
    const el = new ChatPanel();
    el.store = new ActiveSessionStore("sess-1", null, sessionCache, conversations);

    const output = templateToString(callPrivate(el, "renderStreamingContent"));
    expect(output).toContain("Thinking...");
    expect(output).not.toContain("secret");
  });
});


describe("ChatPanel history pagination", () => {
  test("renders persisted record IDs as history anchors", () => {
    const el = panelWithMessages([{ role: "user", content: "visible", timestamp: 1 }]);
    expect(renderConversationEntry(el)).toContain("data-conversation-key=1");
  });

  test("renders a previous-history control that reflects loading state", async () => {
    const el = new ChatPanel();
    let finishLoad!: (loaded: boolean) => void;
    const loadEarlierMessages = mock(() => new Promise<boolean>((resolve) => { finishLoad = resolve; }));
    const container = {
      clientHeight: 600,
      scrollHeight: 1000,
      scrollTop: 20,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
      querySelectorAll: () => [],
    };
    Reflect.set(el, "store", {
      conversation: { entries: [], messages: [], hasEarlierMessages: true, streamingAssistants: [], isCompacting: false, errorMessage: "" },
      sessionData: { activityState: null, state: {} },
      loadEarlierMessages,
    });
    Object.defineProperty(el, "querySelector", {
      configurable: true,
      value: () => container,
    });
    Object.defineProperty(el, "updateComplete", {
      configurable: true,
      value: Promise.resolve(true),
    });

    const template = el.render();
    const output = templateToString(template);
    const [click] = collectTemplateEventListeners(template, "click");

    expect(output).toContain('id="chat-scroll"');
    expect(output).toContain('data-role="load-previous-messages"');
    expect(output).toContain("Load previous messages");
    expect(click).toBeDefined();
    const loading = Reflect.apply(click!, el, [new Event("click")]);
    expect(loadEarlierMessages).toHaveBeenCalledWith();

    const loadingOutput = templateToString(el.render());
    expect(loadingOutput).toContain("Loading previous messages…");
    expect(loadingOutput).toContain("?disabled=true");
    expect(loadingOutput).toContain("aria-busy=true");

    finishLoad(false);
    await loading;
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
  test("a composer submit hides only its optimistic message while thinking remains visible", async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const viewport = new EventTarget();
    Object.assign(viewport, {
      matchMedia: () => ({ matches: false }),
      visualViewport: null,
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: viewport });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { body: {} } });

    const el = new ChatPanel();
    try {
      const prompt = mock((_sessionId: string, _message: ClientPromptContent) => undefined);
      const client = new StubClient();
      client.prompt = prompt;
      const sessionCache = new SessionCache();
      cacheSessionData(sessionCache, "sess-1");
      const store = new ActiveSessionStore("sess-1", client, sessionCache);
      el.store = store;

      const [submit] = collectTemplateEventListeners(el.render(), "composer-submit");
      if (!submit) throw new Error("Expected composer submit listener");
      submit.call(el, new CustomEvent("composer-submit", {
        detail: {
          content: [{ type: "text", text: "hello" }],
          source: { rect: { left: 10, top: 600, width: 300, height: 44 } },
        },
      }));

      const submittedEntry = store.conversation.entries[0];
      if (!submittedEntry || submittedEntry.id !== null) throw new Error("Expected optimistic entry");
      const duringAnimation = templateToString(el.render());
      const animatingMessage = renderConversationEntry(el);
      expect(animatingMessage).toContain(`data-message-key=${submittedEntry.localId}`);
      expect(animatingMessage).toContain("sent-message-target-hidden");
      expect(duringAnimation).toContain('class="mb-3 space-y-2"');
      expect(duringAnimation).not.toContain('class="mb-3 space-y-2 opacity-0"');
      expect(duringAnimation).toContain("Thinking...");
      expect(prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);

      viewport.dispatchEvent(new Event("resize"));
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
      else Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    }

    await Promise.resolve();
    const afterCancellation = templateToString(el.render());
    expect(renderConversationEntry(el)).not.toContain("sent-message-target-hidden");
    expect(afterCancellation).toContain('class="mb-3 space-y-2"');
    expect(afterCancellation).not.toContain('class="mb-3 space-y-2 opacity-0"');
  });

  test("history updates render normally without entering the local-submit animation", () => {
    const el = new ChatPanel();
    const conversations = new ConversationsStore();
    el.store = new ActiveSessionStore("sess-1", null, undefined, conversations);

    conversations.addOptimisticUserMessage("sess-1", [{ type: "text", text: "from peer or refresh" }]);

    const output = renderConversationEntry(el);
    expect(output).toContain("from peer or refresh");
    expect(output).not.toContain("sent-message-target-hidden");
  });
});

describe("ChatPanel refresh contract", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  afterEach(() => { globalThis.requestAnimationFrame = originalRaf; });

  test("sessionData refresh during a run preserves optimistic messages and streaming tool UI", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });

    const client = new StubClient();
    client.prompt = mock(() => {});
    const { el, store, conversationsStore } = setupPanel({ client });

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    notify(store);
    setPersistedMessages(conversationsStore, "sess-1", [{ role: "user", content: "earlier prompt", timestamp: 100 }]);

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "new prompt" }] } }));
    startStreamingWithTool(conversationsStore);

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);

    expect(get(el, "messages")).toEqual([
      { role: "user", content: "earlier prompt", timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: expect.any(Number) },
    ]);
    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingAssistants")).toHaveLength(1);

    cleanupPanel(el);
  });

  test("stale persisted messages do not drop an optimistic user message", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });

    const client = new StubClient();
    client.prompt = mock(() => {});
    const { el, store, conversationsStore } = setupPanel({ client });
    const persisted: AgentMessage[] = [{ role: "user", content: "earlier prompt", timestamp: 100 }];

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    setPersistedMessages(conversationsStore, "sess-1", persisted);
    notify(store);

    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "new prompt" }] } }));

    // A quick metadata/messages refresh can still reflect the DB state before
    // the just-sent prompt has been committed. The UI should layer the local
    // optimistic user message on top of that stale persisted snapshot.
    setSessionData(store, makeSessionData({ messageCount: 1 }));
    setPersistedMessages(conversationsStore, "sess-1", [...persisted]);
    notify(store);

    expect(get(el, "messages")).toEqual([
      { role: "user", content: "earlier prompt", timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: expect.any(Number) },
    ]);

    cleanupPanel(el);
  });

  test("pending local user messages drop once persisted messages catch up", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });

    const client = new StubClient();
    client.prompt = mock(() => {});
    const { el, store, conversationsStore } = setupPanel({ client });

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    setPersistedMessages(conversationsStore, "sess-1", []);
    notify(store);
    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: [{ type: "text", text: "new prompt" }] } }));
    const pendingTimestamp = get(el, "messages")[0].timestamp;

    const persisted: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: pendingTimestamp + 1 },
    ];
    setPersistedMessages(conversationsStore, "sess-1", persisted);
    notify(store);

    expect(get(el, "messages")).toEqual(persisted);
    cleanupPanel(el);
  });

  test("agent_end ignores runtime user copies while promoting the final assistant", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });

    const client = new StubClient();
    client.prompt = mock(() => {});
    const { el, store, conversationsStore } = setupPanel({ client });
    const promptContent = [{ type: "text" as const, text: "new prompt" }];

    setSessionData(store, makeSessionData({ messageCount: 0 }));
    notify(store);
    callPrivate(el, "handleSend", new CustomEvent("composer-submit", { detail: { content: promptContent } }));
    const pendingTimestamp = get(el, "messages")[0].timestamp;

    const runMessages: AgentMessage[] = [
      { role: "user", content: promptContent, timestamp: pendingTimestamp - 1000 },
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: pendingTimestamp - 500 },
    ];
    conversationsStore.applyEvent("sess-1", { type: "message_end", message: runMessages[1] });
    conversationsStore.applyEvent("sess-1", { type: "agent_end", messages: runMessages });

    expect(get(el, "messages")).toEqual([
      { role: "user", content: promptContent, timestamp: pendingTimestamp },
      runMessages[1],
    ]);
    expect(get(el, "streamingAssistants")).toEqual([]);
    cleanupPanel(el);
  });

  test("persisted conversation messages hydrate an empty panel even when streaming", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setupPanel();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 2 }));
    notify(store);

    setPersistedMessages(conversationsStore, "sess-1", [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
    ]);

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "messages")).toEqual(store.conversation.messages);
  });

  test("disconnect unsubscribes from store render notifications", () => {
    const { el, store, conversationsStore } = setupPanel();

    setSessionData(store, makeSessionData({ messageCount: 1 }));
    setPersistedMessages(conversationsStore, "sess-1", [{ role: "user", content: "before", timestamp: 100 }]);
    notify(store);
    expect(get(el, "messages")).toEqual(store.conversation.messages);

    const requestUpdate = mock(() => undefined);
    Reflect.set(el, "requestUpdate", requestUpdate);

    const unsub = get(el, "unsubscribeStore");
    if (typeof unsub === "function") unsub();
    Reflect.set(el, "unsubscribeStore", undefined);

    setPersistedMessages(conversationsStore, "sess-1", [{ role: "user", content: "after", timestamp: 200 }]);
    notify(store);

    expect(requestUpdate).not.toHaveBeenCalled();
  });
});

describe("ChatPanel stale streaming reconciliation", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  afterEach(() => { globalThis.requestAnimationFrame = originalRaf; });

  test("keeps streaming through agent_end and stops only after settlement metadata is terminal", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setupPanel();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);
    const finalAssistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }], timestamp: 200 };
    conversationsStore.applyEvent("sess-1", { type: "message_end", message: finalAssistant });
    conversationsStore.applyEvent("sess-1", { type: "agent_end", messages: [finalAssistant] });

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingAssistants")).toEqual([]);
    expect(get(el, "messages")).toEqual([finalAssistant]);

    conversationsStore.applyEvent("sess-1", { type: "agent_settled" });
    expect(get(el, "isStreaming")).toBe(true);

    setSessionData(store, makeSessionData({ activityState: "finished", messageCount: 2 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    cleanupPanel(el);
  });

  test("preserves unmatched streaming assistants when metadata transitions from running", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setupPanel();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);
    startStreamingWithTool(conversationsStore);
    const start = { role: "assistant" as const, content: [], timestamp: 200 };
    const message = { ...start, content: [{ type: "text" as const, text: "Running..." }] };
    conversationsStore.applyEvent("sess-1", { type: "message_start", message: start });
    conversationsStore.applyEvent("sess-1", {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "snapshot" },
    });

    expect(get(el, "streamingAssistants")).toHaveLength(2);

    // Metadata refresh after missed agent_end
    setSessionData(store, makeSessionData({ messageCount: 3 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingAssistants")).toHaveLength(2);
    cleanupPanel(el);
  });

  test("accepts persisted messages when metadata transitions activityState from running", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setupPanel();

    setPersistedMessages(conversationsStore, "sess-1", [{ role: "user", content: "hello", timestamp: 1000 }]);
    notify(store);

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    notify(store);
    startStreamingWithTool(conversationsStore);

    const finalMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Here are your files" }], timestamp: 2000 },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "file1.txt" }], isError: false, timestamp: 3000 },
    ];
    setPersistedMessages(conversationsStore, "sess-1", finalMessages);
    setSessionData(store, makeSessionData({ messageCount: 3 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingAssistants")).toHaveLength(1);
    expect(get(el, "messages")).toEqual(finalMessages);
    cleanupPanel(el);
  });

  test("persisted output clears streaming assistants before metadata catches up", () => {
    globalThis.requestAnimationFrame = mock((cb: FrameRequestCallback) => { cb(0); return 1; });
    const { el, store, conversationsStore } = setupPanel();

    setSessionData(store, makeSessionData({ activityState: "running", messageCount: 1 }));
    setPersistedMessages(conversationsStore, "sess-1", [{ role: "user", content: "hello", timestamp: 1000 }]);
    notify(store);
    startStreamingWithTool(conversationsStore, 2000);

    // Messages arrive first, metadata still says running.
    const finalMessages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1000 },
      ...completedToolTurn([
        { id: "tool-1", name: "bash", arguments: { command: "ls" }, result: "file1.txt" },
      ], "Done", 2000),
    ];
    setPersistedMessages(conversationsStore, "sess-1", finalMessages);
    notify(store);

    expect(get(el, "isStreaming")).toBe(true);
    expect(get(el, "streamingAssistants")).toEqual([]);
    expect(get(el, "messages")).toEqual(finalMessages);

    // Metadata catches up.
    setSessionData(store, makeSessionData({ messageCount: 4 }));
    notify(store);

    expect(get(el, "isStreaming")).toBe(false);
    expect(get(el, "streamingAssistants")).toEqual([]);
    expect(get(el, "messages")).toEqual(finalMessages);
    cleanupPanel(el);
  });
});
