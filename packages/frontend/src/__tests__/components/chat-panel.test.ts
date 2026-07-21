import { describe, expect, mock, test } from "bun:test";
import { ChatPanel } from "../../components/chat-panel.js";
import type { ClientPromptContent } from "../../models/chat-content.js";
import { ActiveSessionStore } from "../../models/stores/active-session-store.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { AgentMessage } from "../../models/chat-state.js";
import { setPersistedMessages } from "../helpers/conversations.js";
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
  setPersistedMessages(cache, sessionId, messages);
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
        streamingBlocks: [],
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
        streamingBlocks: [],
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
      conversation: { entries: [], messages: [], hasEarlierMessages: true, streamingBlocks: [], isCompacting: false, errorMessage: "" },
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
