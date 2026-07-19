import { afterEach, describe, expect, test } from "bun:test";
import { ConversationsStore } from "../../../models/stores/conversations-store.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import type { AgentMessage } from "../../../models/chat-state.js";
import { conversationPage, setPersistedMessages } from "../../helpers/conversations.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

function textUser(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function cachedSession(isRunning: boolean) {
  return {
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    activityState: isRunning ? "running" as const : "finished" as const,
    messageCount: 0,
    state: { model: null, thinkingLevel: "off" },
  };
}

describe("ConversationsStore", () => {
  afterEach(() => { restoreFetch(); });

  test("loads latest, forward, and earlier pages through cursor API", async () => {
    const conversations = new ConversationsStore();
    const earlier = textUser("earlier", 100);
    const latest = textUser("latest", 200);
    const newer = textUser("newer", 300);
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") {
        return Response.json(conversationPage(
          [{ id: "2", parentId: "1", message: latest }],
          { hasPreviousPage: true, previousCursor: "cursor-2", hasNextPage: true, endCursor: "cursor-2" },
        ));
      }
      if (url === "/api/sessions/sess-1/messages?after=cursor-2") {
        return Response.json(conversationPage(
          [{ id: "3", parentId: "2", message: newer }],
          { endCursor: "cursor-3" },
        ));
      }
      if (url === "/api/sessions/sess-1/messages?before=cursor-2") {
        return Response.json(conversationPage([
          { id: "1", parentId: null, message: earlier },
        ], { hasNextPage: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    expect(await conversations.syncMessages("sess-1")).toBe(true);
    expect(await conversations.loadEarlierMessages("sess-1")).toBe(true);

    expect(calls).toEqual([
      "/api/sessions/sess-1/messages",
      "/api/sessions/sess-1/messages?after=cursor-2",
      "/api/sessions/sess-1/messages?before=cursor-2",
    ]);
    expect(conversations.get("sess-1").messages).toEqual([earlier, latest, newer]);
  });

  test("stores session-scoped websocket errors", () => {
    const conversations = new ConversationsStore();

    conversations.applyEvent("sess-1", { type: "ws_error", sessionId: "sess-1", error: "Missing message field" });

    expect(conversations.get("sess-1").errorMessage).toBe("Missing message field");
  });

  test("ignores frontend events that are not chat conversation events", () => {
    const conversations = new ConversationsStore();

    conversations.applyEvent("sess-1", { type: "session_updated", sessionId: "sess-1", projectId: 42 });
    conversations.applyEvent("sess-1", { type: "task_updated", projectId: 42 });

    expect(conversations.get("sess-1")).toMatchObject({
      entries: [],
      messages: [],
      hasEarlierMessages: false,
      streamingBlocks: [],
    });
  });

  test("keeps conversation state keyed by session for non-active events", () => {
    const conversations = new ConversationsStore();

    conversations.applyEvent("inactive-session", { type: "agent_start" });
    conversations.applyEvent("inactive-session", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });

    expect(conversations.get("active-session").streamingBlocks).toEqual([]);
    expect(conversations.get("inactive-session").streamingBlocks).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  test("prepending history preserves websocket message tail and streaming blocks", () => {
    const conversations = new ConversationsStore();
    const earlier = textUser("earlier", 100);
    const latest = textUser("latest", 200);
    const liveAssistant: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "live reply" }],
      timestamp: 300,
    };

    conversations.mergeMessages("sess-1", conversationPage(
      [{ id: "2", parentId: "1", message: latest }],
      { hasPreviousPage: true, previousCursor: "cursor-2" },
    ));
    conversations.applyEvent("sess-1", {
      type: "user_message",
      message: [{ type: "text", text: "live prompt" }],
    });
    const liveUser = conversations.get("sess-1").messages.at(-1)!;
    conversations.applyEvent("sess-1", { type: "agent_end", messages: [liveAssistant] });
    conversations.applyEvent("sess-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "still working" },
    });

    conversations.mergeMessages("sess-1", conversationPage(
      [{ id: "1", parentId: null, message: earlier }],
      { hasNextPage: true },
    ), { earlier: true });

    const state = conversations.get("sess-1");
    expect(state.messages).toEqual([earlier, latest, liveUser, liveAssistant]);
    expect(state.entries.slice(0, 2)).toEqual([
      { id: "1", parentId: null, message: earlier },
      { id: "2", parentId: "1", message: latest },
    ]);
    expect(state.entries.slice(2).map((entry) => entry.id)).toEqual([null, null]);
    expect(state.entries.slice(2).every((entry) => (
      entry.id === null && entry.localId.length > 0
    ))).toBe(true);
    expect(state.streamingBlocks).toEqual([{ type: "text", text: "still working" }]);
  });

  test("reconciles newly persisted differently shaped users with optimistic entries FIFO", () => {
    const conversations = new ConversationsStore();
    conversations.mergeMessages("sess-1", conversationPage([
      { id: "old", parentId: null, message: textUser("old", 100) },
    ]));
    const original = [{ type: "text" as const, text: "/dip start" }];
    conversations.addOptimisticUserMessage("sess-1", original, 5_000);

    const strippedPersisted = [{ type: "text" as const, text: "/dip start\n" }];
    conversations.mergeMessages("sess-1", conversationPage([
      { id: "new", parentId: "old", message: { role: "user", content: strippedPersisted, timestamp: 5_500 } },
    ]));

    expect(conversations.get("sess-1").entries).toEqual([
      { id: "old", parentId: null, message: textUser("old", 100) },
      { id: "new", parentId: "old", message: { role: "user", content: strippedPersisted, timestamp: 5_500 } },
    ]);
  });

  test("reconciles repeated identical local and remote prompts one-for-one", () => {
    const conversations = new ConversationsStore();
    conversations.mergeMessages("sess-1", conversationPage([
      { id: "old", parentId: null, message: textUser("old", 100) },
    ]));
    const content = [{ type: "text" as const, text: "repeat this prompt" }];

    conversations.addOptimisticUserMessage("sess-1", content, 5_000);
    conversations.applyEvent("sess-1", { type: "user_message", message: content });
    expect(conversations.get("sess-1").messages.filter(({ role }) => role === "user")).toHaveLength(3);

    conversations.mergeMessages("sess-1", conversationPage([
      { id: "persisted-1", parentId: "old", message: { role: "user", content, timestamp: 5_500 } },
    ]));
    expect(conversations.get("sess-1").entries.filter(({ id }) => id === null)).toHaveLength(1);

    conversations.mergeMessages("sess-1", conversationPage([
      { id: "persisted-2", parentId: "persisted-1", message: { role: "user", content, timestamp: 6_500 } },
    ]));
    expect(conversations.get("sess-1").entries.filter(({ id }) => id === null)).toHaveLength(0);
    expect(conversations.get("sess-1").entries.map(({ id }) => id)).toEqual(["old", "persisted-1", "persisted-2"]);
  });

  test("stale overlapping pages never consume pending optimistic users", () => {
    const conversations = new ConversationsStore();
    const stale = { id: "stale", parentId: null, message: textUser("same", 100) };
    conversations.mergeMessages("overlap", conversationPage([stale]));
    conversations.addOptimisticUserMessage("overlap", [{ type: "text", text: "same" }], 5_000);

    conversations.mergeMessages("overlap", conversationPage([stale]));
    conversations.mergeMessages("overlap", conversationPage([stale]));

    expect(conversations.get("overlap").entries.filter(({ id }) => id === null)).toHaveLength(1);
  });

  test("stale persisted snapshots do not clear active streaming blocks", () => {
    const conversations = new ConversationsStore();
    const persisted = [textUser("earlier", 100)];
    setPersistedMessages(conversations, "sess-1", persisted);
    conversations.applyEvent("sess-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });

    setPersistedMessages(conversations, "sess-1", [...persisted]);

    expect(conversations.get("sess-1").streamingBlocks).toEqual([{ type: "text", text: "working" }]);
    expect(conversations.get("sess-1").messages).toEqual(persisted);
  });

  test("persisted snapshots that advance past rendered messages clear active streaming blocks", () => {
    const conversations = new ConversationsStore();
    setPersistedMessages(conversations, "sess-1", [textUser("hello", 100)]);
    conversations.applyEvent("sess-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });

    const finalMessages: AgentMessage[] = [
      textUser("hello", 100),
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 200 },
    ];
    setPersistedMessages(conversations, "sess-1", finalMessages);

    expect(conversations.get("sess-1").streamingBlocks).toEqual([]);
    expect(conversations.get("sess-1").messages).toEqual(finalMessages);
  });

  test("when server state leaves streaming it clears stale compacting state", () => {
    const conversations = new ConversationsStore();
    conversations.applyEvent("sess-1", { type: "compaction_start", reason: "threshold" });

    expect(conversations.get("sess-1").isCompacting).toBe(true);

    conversations.clearStreamingState("sess-1");

    expect(conversations.get("sess-1").isCompacting).toBe(false);
  });

  test("prunes unobserved conversation state when cached activity is not running", () => {
    const sessionCache = new SessionCache();
    const conversations = new ConversationsStore({ sessionCache });

    conversations.applyEvent("background-session", { type: "agent_start" });
    conversations.applyEvent("background-session", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });

    sessionCache.set("background-session", cachedSession(true));
    expect(conversations.get("background-session").streamingBlocks).toEqual([{ type: "text", text: "working" }]);

    sessionCache.set("background-session", cachedSession(false));

    expect(conversations.get("background-session")).toMatchObject({
      messages: [],
      hasEarlierMessages: false,
      streamingBlocks: [],
    });
  });

  test("keeps observed conversation state when cached activity is not running", () => {
    const sessionCache = new SessionCache();
    const conversations = new ConversationsStore({ sessionCache });
    const unsubscribe = conversations.subscribe("active-session", () => {});

    conversations.applyEvent("active-session", { type: "agent_start" });
    conversations.applyEvent("active-session", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });

    sessionCache.set("active-session", cachedSession(false));

    expect(conversations.get("active-session").streamingBlocks).toEqual([{ type: "text", text: "working" }]);
    unsubscribe();
  });

  test("prunes completed conversation after last subscriber unsubscribes", () => {
    const sessionCache = new SessionCache();
    const conversations = new ConversationsStore({ sessionCache });
    const unsubscribe = conversations.subscribe("sess-1", () => {});

    conversations.applyEvent("sess-1", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "stale active state" },
    });
    sessionCache.set("sess-1", cachedSession(false));
    expect(conversations.get("sess-1").streamingBlocks).toEqual([{ type: "text", text: "stale active state" }]);

    unsubscribe();

    expect(conversations.get("sess-1")).toMatchObject({
      messages: [],
      hasEarlierMessages: false,
      streamingBlocks: [],
    });
  });
});
