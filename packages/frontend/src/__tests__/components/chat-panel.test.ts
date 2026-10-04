import { describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../../components/chat-panel.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import type { SessionListView as SessionListItem } from "@backend/models/sessions.js";
import { applyStreamingAssistant, setPersistedMessages } from "../helpers/conversations.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function cacheSessionData(
  cache: SessionCache,
  activityState: "running" | "finished" | null = null,
  parentSessionId: string | null = null,
  pendingOperation: { kind: "run" } | null = null,
) {
  cache.set("sess-1", {
    projectId: 42,
    taskId: null,
    parentSessionId,
    name: null,
    createdAt: "",
    updatedAt: "",
    activityState,
    pendingOperation,
    messageCount: 0,
    placement: { available: true, nodeId: "internal", nodeName: "Internal", path: "" },
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
  test("reports whether the foreground conversation is observed", () => {
    const panel = new ChatPanel();
    const setObserved = mock((_observed: boolean) => {});
    Reflect.set(panel, "store", { setObserved });
    Reflect.set(panel, "focusInput", () => {});
    Reflect.set(panel, "autoScroll", () => {});
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const documentState = { visibilityState: "visible" };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentState,
    });

    try {
      panel.visible = true;
      panel.updated(new Map([["visible", false]]));
      panel.visible = false;
      panel.updated(new Map([["visible", true]]));
      expect(setObserved.mock.calls.map((call) => call[0])).toEqual([true, false]);
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("passes domain messages and stable history identity to chat-message", () => {
    const conversations = new ConversationsStore();
    setPersistedMessages(conversations, "sess-1", [{ role: "user", content: "visible", timestamp: 1 }]);
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, undefined, conversations);
    panel.projectId = 42;
    panel.checkoutPath = "/work/project";

    const output = templateToString(firstRepeatTemplate(panel));

    expect(output).toContain("<chat-message");
    expect(output).toContain("data-conversation-key=entry-1");
    expect(output).toContain("data-message-key=entry-1");
    expect(output).toContain(".sessionId=sess-1");
    expect(output).toContain(".projectId=42");
    expect(output).toContain(".checkoutPath=/work/project");
  });

  test("passes the source session's current display title to session updates", () => {
    const conversations = new ConversationsStore();
    setPersistedMessages(conversations, "sess-1", [{
      role: "user",
      content: "Investigation complete",
      metadata: { sourceSessionId: "child-1" },
      timestamp: 1,
    }]);
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, undefined, conversations);
    Reflect.set(panel, "projectStore", {
      getSession: () => ({ name: null, firstMessage: "Investigate the cache" }),
    });

    expect(templateToString(firstRepeatTemplate(panel))).toContain(".sourceSessionTitle=Investigate the cache");
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

  test("offers to resume a pending inactive operation", async () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, null, null, { kind: "run" });
    const store = new ActiveSessionStore("sess-1", null, sessionCache, new ConversationsStore());
    const resume = mock(async () => true);
    Object.defineProperty(store, "resumePendingOperation", { value: resume });
    const panel = new ChatPanel();
    panel.store = store;

    const pending = callPrivate(panel, "renderPendingOperation");
    expect(templateToString(pending)).toContain("Resume interrupted session");
    const [click] = collectTemplateEventListeners(pending, "click");
    await click?.call(panel, new Event("click"));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test("keeps streaming aggregate indicators in the panel", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "running");
    const conversations = new ConversationsStore();
    conversations.applyEvent("sess-1", {
      type: "message_update",
      streamId: "stream-1",
      message: { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "secret" }] },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
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

  test("links a child conversation to its loaded parent title", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, null, "parent/session");
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, sessionCache, new ConversationsStore());
    panel.parentSession = {
      id: "parent/session",
      projectId: 42,
      taskId: null,
      parentSessionId: null,
      name: "Original investigation",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      firstMessage: "Investigate the bug",
      messageCount: 1,
      activityState: null,
      pinnedAt: null,
      archivedAt: null,
      placement: null,
      pendingOperation: null,
      runtimeType: null,
      state: null,
    };

    const output = templateToString(panel.render());

    expect(output).toContain('aria-label="Parent session"');
    expect(output).toContain('data-role="parent-session-rail"');
    expect(output).toContain('href="#/session/parent%2Fsession"');
    expect(output).toContain("Parent session");
    expect(output).toContain("Original investigation");
    expect(output).not.toContain("Investigate the bug");
    expect(output.indexOf('data-role="parent-session-rail"')).toBeLessThan(
      output.indexOf('id="chat-scroll"'),
    );
  });

  test("uses the loaded parent first message or fallback label", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, null, "parent-1");
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, sessionCache, new ConversationsStore());
    panel.parentSession = {
      id: "parent-1",
      projectId: 42,
      taskId: null,
      parentSessionId: null,
      name: null,
      createdAt: null,
      updatedAt: null,
      firstMessage: "Start with the API",
      messageCount: null,
      activityState: null,
      pinnedAt: null,
      archivedAt: null,
      placement: null,
      pendingOperation: null,
      runtimeType: null,
      state: null,
    };

    expect(templateToString(panel.render())).toContain("Start with the API");

    panel.parentSession = null;
    expect(templateToString(panel.render())).toContain("Parent session");
  });

  test("hides parent navigation for root sessions", () => {
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache);
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, sessionCache, new ConversationsStore());

    expect(templateToString(panel.render())).not.toContain('aria-label="Parent session"');
  });

  test("renders running child sessions as a separate linked card group", () => {
    const child: SessionListItem = {
      id: "child/session",
      projectId: 42,
      taskId: null,
      parentSessionId: "sess-1",
      name: "Investigate the cache",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      messageCount: 1,
      firstMessage: "Investigate",
      activityState: "running",
      pinnedAt: null,
      archivedAt: null,
      placement: { available: true, nodeId: "internal", nodeName: "Internal", path: "" },
    };
    const sessionCache = new SessionCache();
    cacheSessionData(sessionCache, "running");
    const conversations = new ConversationsStore();
    conversations.applyEvent("sess-1", {
      type: "message_update",
      streamId: "stream-1",
      message: { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "secret" }] },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", null, sessionCache, conversations);
    panel.runningChildSessions = [child];

    const output = templateToString(panel.render());

    expect(output).toContain('aria-label="Running child sessions"');
    expect(output).toContain("Investigate the cache");
    expect(output).toContain('href="#/session/child%2Fsession"');
    expect(output).toContain("Running");
    expect(output.indexOf('data-role="streaming-content"')).toBeLessThan(
      output.indexOf('data-role="running-child-sessions"'),
    );
  });

  test("coordinates optimistic identity from composer submission", () => {
    const client = new StubClient();
    const prompt = mock((_sessionId: string, _message: ClientPromptContent, _clientId: string) => undefined);
    client.prompt = prompt;
    const conversations = new ConversationsStore();
    const panel = new ChatPanel();
    panel.store = new ActiveSessionStore("sess-1", client, undefined, conversations);

    callPrivate(panel, "handleSend", new CustomEvent("composer-submit", {
      detail: { content: [{ type: "text", text: "hello" }], source: null },
    }));

    const [message] = panel.store.conversation.messages;
    if (message?.raw.role !== "user") throw new Error("Expected optimistic user submission");
    const clientId = prompt.mock.calls[0]?.[2];
    expect(message.renderKey).toBe(`submission-${clientId}`);
    expect(templateToString(firstRepeatTemplate(panel))).toContain(`data-message-key=submission-${clientId}`);
    expect(client.prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }], clientId);
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
    expect(output).toContain("streaming-assistant-test-stream-200");
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
