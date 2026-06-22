import { describe, expect, test } from "bun:test";
import { ConversationsStore } from "../../../models/stores/conversations-store.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import type { AgentMessage } from "../../../models/chat-state.js";

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
      messages: [],
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

  test("stale persisted snapshots do not drop optimistic user messages", () => {
    const conversations = new ConversationsStore();
    const persisted = [textUser("earlier", 100)];

    conversations.setPersistedMessages("sess-1", persisted);
    conversations.addOptimisticUserMessage("sess-1", [{ type: "text", text: "new prompt" }], 500);
    conversations.setPersistedMessages("sess-1", [...persisted]);

    expect(conversations.get("sess-1").messages).toEqual([
      textUser("earlier", 100),
      { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: 500 },
    ]);
  });

  test("when server state leaves streaming it clears stale blocks and accepts persisted messages", () => {
    const conversations = new ConversationsStore();
    conversations.setPersistedMessages("sess-1", [textUser("hello", 100)]);
    conversations.applyEvent("sess-1", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const finalMessages: AgentMessage[] = [
      textUser("hello", 100),
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 200 },
    ];
    conversations.setPersistedMessages("sess-1", finalMessages);
    conversations.clearStreamingState("sess-1");

    expect(conversations.get("sess-1").streamingBlocks).toEqual([]);
    expect(conversations.get("sess-1").messages).toEqual(finalMessages);
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
      streamingBlocks: [],
      persistedMessages: [],
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
      streamingBlocks: [],
      persistedMessages: [],
    });
  });
});
