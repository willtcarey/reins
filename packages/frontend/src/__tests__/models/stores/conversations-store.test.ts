import { afterEach, describe, expect, test } from "bun:test";
import { ConversationsStore } from "../../../models/stores/conversations-store.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import type { AgentMessage } from "../../../models/chat-state.js";
import {
  applyStreamingAssistant,
  applyStreamingMessage,
  completedToolTurn,
  conversationPage,
  setPersistedMessages,
  streamingContentKeys,
  type StreamingFixture,
} from "../../helpers/conversations.js";
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
      streamingAssistants: [],
    });
  });

  test("keeps conversation state keyed by session for non-active events", () => {
    const conversations = new ConversationsStore();

    applyStreamingAssistant(conversations, "inactive-session", ["hello"], 100);

    expect(conversations.get("active-session").streamingAssistants).toEqual([]);
    expect(streamingContentKeys(conversations, "inactive-session")).toEqual(["text:hello"]);
  });

  test("prepending history preserves websocket message tail and streaming assistants", () => {
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
    conversations.applyEvent("sess-1", { type: "message_end", message: liveAssistant });
    applyStreamingAssistant(conversations, "sess-1", ["still working"], 400);

    conversations.mergeMessages("sess-1", conversationPage(
      [{ id: "1", parentId: null, message: earlier }],
      { hasNextPage: true },
    ), { earlier: true });

    const state = conversations.get("sess-1");
    expect(state.messages).toEqual([earlier, latest, liveUser]);
    expect(state.entries.slice(0, 2)).toEqual([
      { id: "1", parentId: null, message: earlier },
      { id: "2", parentId: "1", message: latest },
    ]);
    expect(state.entries.slice(2).map((entry) => entry.id)).toEqual([null]);
    expect(state.entries.slice(2).every((entry) => (
      entry.id === null && entry.localId.length > 0
    ))).toBe(true);
    expect(streamingContentKeys(conversations, "sess-1")).toEqual(["text:live reply", "text:still working"]);
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

  test("agent_end exposes final output immediately and persistence replaces it by stable identity", () => {
    const conversations = new ConversationsStore();
    const liveAssistant: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "live final" }],
      timestamp: 200,
    };
    const liveToolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "live result" }],
      isError: false,
      timestamp: 300,
    };

    conversations.applyEvent("sess-1", {
      type: "agent_end",
      messages: [textUser("runtime copy", 100), liveAssistant, liveToolResult],
    });

    expect(conversations.get("sess-1").messages).toEqual([liveAssistant, liveToolResult]);
    expect(conversations.get("sess-1").entries.every(({ id }) => id === null)).toBe(true);

    const persistedAssistant: AgentMessage = {
      ...liveAssistant,
      content: [{ type: "text", text: "canonical final" }],
    };
    const persistedToolResult: AgentMessage = {
      ...liveToolResult,
      content: [{ type: "text", text: "canonical result" }],
      timestamp: 350,
    };
    setPersistedMessages(conversations, "sess-1", [
      textUser("canonical prompt", 150),
      persistedAssistant,
      persistedToolResult,
    ]);

    expect(conversations.get("sess-1").messages).toEqual([
      textUser("canonical prompt", 150),
      persistedAssistant,
      persistedToolResult,
    ]);
  });

  test("reconciles live tool results by stable tool-call ID", () => {
    const conversations = new ConversationsStore();
    const user = textUser("inspect it", 100);
    conversations.mergeMessages("sess-1", conversationPage([
      { id: "user", parentId: null, message: user },
    ]));
    conversations.applyEvent("sess-1", {
      type: "agent_end",
      messages: [{
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "live result" }],
        isError: false,
        timestamp: 200,
      }],
    });

    const persistedResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "persisted result" }],
      isError: false,
      timestamp: 250,
    };
    conversations.mergeMessages("sess-1", conversationPage([
      { id: "result", parentId: "user", message: persistedResult },
    ]));

    expect(conversations.get("sess-1").messages).toEqual([user, persistedResult]);
  });

  test("first canonical page replaces the optimistic prompt and matching live tool", () => {
    const conversations = new ConversationsStore();
    const prompt = [{ type: "text" as const, text: "Push that" }];
    const tool = { id: "tool-1", name: "bash", arguments: { command: "git push" }, result: "pushed" };
    conversations.addOptimisticUserMessage("sess-1", prompt, 100);
    applyStreamingAssistant(conversations, "sess-1", [{ ...tool, done: true }], 200);
    applyStreamingMessage(conversations, "sess-1", 202, ["Pushed successfully."]);

    const canonicalMessages: AgentMessage[] = [
      { role: "user", content: prompt, timestamp: 100 },
      ...completedToolTurn([tool], "Pushed successfully.", 200),
    ];
    setPersistedMessages(conversations, "sess-1", canonicalMessages);

    expect(conversations.get("sess-1").messages).toEqual(canonicalMessages);
    expect(streamingContentKeys(conversations, "sess-1")).toEqual([]);
  });

  test("a stale first page preserves unrelated active streaming work", () => {
    const conversations = new ConversationsStore();
    conversations.addOptimisticUserMessage("sess-1", [{ type: "text", text: "new work" }], 500);
    applyStreamingAssistant(conversations, "sess-1", [{ id: "live-tool" }]);

    setPersistedMessages(conversations, "sess-1", [
      textUser("old work", 100),
      { role: "assistant", content: [{ type: "text", text: "old response" }], timestamp: 200 },
    ]);

    expect(streamingContentKeys(conversations, "sess-1")).toEqual(["tool:live-tool"]);
  });

  const reconciliationCases: Array<{
    name: string;
    streaming: Array<{ timestamp: number; blocks: StreamingFixture[] }>;
    persisted: AgentMessage[];
    expected: string[];
  }> = [
    {
      name: "a partial snapshot removes the entire matching streaming assistant",
      streaming: [
        { timestamp: 200, blocks: ["Checking", { id: "tool-1", done: true }] },
        { timestamp: 300, blocks: ["Checking another file", { id: "tool-2" }] },
      ],
      persisted: completedToolTurn([{ id: "tool-1" }], "not persisted yet", 200).slice(0, 2),
      expected: ["text:Checking another file", "tool:tool-2"],
    },
    {
      name: "a completed turn preserves a newer unmatched streaming assistant",
      streaming: [
        { timestamp: 200, blocks: [{ id: "tool-1", done: true }] },
        { timestamp: 202, blocks: ["Acknowledged text"] },
        { timestamp: 500, blocks: [{ id: "tool-2" }, "Newer text"] },
      ],
      persisted: completedToolTurn([{ id: "tool-1" }], "Acknowledged text", 200),
      expected: ["tool:tool-2", "text:Newer text"],
    },
    {
      name: "matching persisted assistant timestamps clear multiple streaming assistants",
      streaming: [
        { timestamp: 200, blocks: [{ id: "tool-1", done: true }, { id: "tool-2", done: true }] },
        { timestamp: 203, blocks: ["Both files checked."] },
      ],
      persisted: completedToolTurn([{ id: "tool-1" }, { id: "tool-2" }], "Both files checked.", 200),
      expected: [],
    },
  ];

  for (const scenario of reconciliationCases) {
    test(scenario.name, () => {
      const conversations = new ConversationsStore();
      conversations.applyEvent("sess-1", { type: "agent_start" });
      for (const group of scenario.streaming) {
        applyStreamingMessage(conversations, "sess-1", group.timestamp, group.blocks);
      }
      setPersistedMessages(conversations, "sess-1", scenario.persisted);
      expect(streamingContentKeys(conversations, "sess-1")).toEqual(scenario.expected);
    });
  }

  test("disconnect leaves snapshots and tool state intact while a later full update recovers", () => {
    const conversations = new ConversationsStore();
    applyStreamingAssistant(conversations, "sess-1", ["Known text", { id: "known-tool" }], 200);

    // A disconnect performs no conversation mutation. Known tool IDs can still
    // be overlaid, while unrelated tool events are ignored.
    conversations.applyEvent("sess-1", {
      type: "tool_execution_update",
      toolCallId: "known-tool",
      toolName: "read",
      args: { resumed: true },
    });
    conversations.applyEvent("sess-1", {
      type: "tool_execution_start",
      toolCallId: "unknown-tool",
      toolName: "read",
      args: {},
    });
    conversations.applyEvent("sess-1", {
      type: "message_update",
      message: {
        role: "assistant",
        timestamp: 300,
        content: [{ type: "text", text: "recovered without start" }],
      },
      assistantMessageEvent: { type: "snapshot" },
    });

    expect(streamingContentKeys(conversations, "sess-1")).toEqual([
      "text:Known text",
      "tool:known-tool",
      "text:recovered without start",
    ]);
    expect(conversations.get("sess-1").streamingAssistants[0]?.toolExecutions["known-tool"]).toMatchObject({
      args: { id: "known-tool", resumed: true },
    });
  });

  test("clearing stale compacting state preserves all conversation work", () => {
    const conversations = new ConversationsStore();
    const persisted = textUser("earlier", 100);
    conversations.mergeMessages("sess-1", conversationPage(
      [{ id: "persisted-1", parentId: null, message: persisted }],
      { hasPreviousPage: true, previousCursor: "earlier-cursor", endCursor: "latest-cursor" },
    ));
    const optimistic = conversations.addOptimisticUserMessage(
      "sess-1",
      [{ type: "text", text: "next prompt" }],
      300,
    );
    if (!optimistic) throw new Error("Expected optimistic entry");
    applyStreamingAssistant(conversations, "sess-1", [{ id: "tool-1", done: true }], 400);
    conversations.applyEvent("sess-1", { type: "compaction_start", reason: "threshold" });
    conversations.setError("sess-1", "still visible");
    const before = conversations.get("sess-1");

    conversations.clearCompactingState("sess-1");

    expect(conversations.get("sess-1")).toEqual({ ...before, isCompacting: false });
    expect(conversations.get("sess-1").entries).toEqual([
      { id: "persisted-1", parentId: null, message: persisted },
      optimistic,
    ]);
    expect(conversations.get("sess-1").streamingAssistants[0]?.toolExecutions["tool-1"]?.result).toBeDefined();
  });

  test("compaction_end still clears compacting state normally", () => {
    const conversations = new ConversationsStore();
    conversations.applyEvent("sess-1", { type: "compaction_start", reason: "threshold" });

    conversations.applyEvent("sess-1", { type: "compaction_end", result: { summary: "done" } });

    expect(conversations.get("sess-1").isCompacting).toBe(false);
  });

  test("stale persisted snapshots do not clear active streaming assistants", () => {
    const conversations = new ConversationsStore();
    const persisted = [textUser("earlier", 100)];
    setPersistedMessages(conversations, "sess-1", persisted);
    applyStreamingAssistant(conversations, "sess-1", ["working"], 200);

    setPersistedMessages(conversations, "sess-1", [...persisted]);

    expect(streamingContentKeys(conversations, "sess-1")).toEqual(["text:working"]);
    expect(conversations.get("sess-1").messages).toEqual(persisted);
  });

  test("persisted snapshots that advance past rendered messages clear active streaming assistants", () => {
    const conversations = new ConversationsStore();
    setPersistedMessages(conversations, "sess-1", [textUser("hello", 100)]);
    applyStreamingAssistant(conversations, "sess-1", ["working"], 200);

    const finalMessages: AgentMessage[] = [
      textUser("hello", 100),
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 200 },
    ];
    setPersistedMessages(conversations, "sess-1", finalMessages);

    expect(conversations.get("sess-1").streamingAssistants).toEqual([]);
    expect(conversations.get("sess-1").messages).toEqual(finalMessages);
  });

  test("prunes unobserved conversation state when cached activity is not running", () => {
    const sessionCache = new SessionCache();
    const conversations = new ConversationsStore({ sessionCache });

    applyStreamingAssistant(conversations, "background-session", ["working"], 100);

    sessionCache.set("background-session", cachedSession(true));
    expect(streamingContentKeys(conversations, "background-session")).toEqual(["text:working"]);

    sessionCache.set("background-session", cachedSession(false));

    expect(conversations.get("background-session")).toMatchObject({
      messages: [],
      hasEarlierMessages: false,
      streamingAssistants: [],
    });
  });

  test("keeps observed conversation state when cached activity is not running", () => {
    const sessionCache = new SessionCache();
    const conversations = new ConversationsStore({ sessionCache });
    const unsubscribe = conversations.subscribe("active-session", () => {});

    applyStreamingAssistant(conversations, "active-session", ["working"], 100);

    sessionCache.set("active-session", cachedSession(false));

    expect(streamingContentKeys(conversations, "active-session")).toEqual(["text:working"]);
    unsubscribe();
  });

  test("prunes completed conversation after last subscriber unsubscribes", () => {
    const sessionCache = new SessionCache();
    const conversations = new ConversationsStore({ sessionCache });
    const unsubscribe = conversations.subscribe("sess-1", () => {});

    applyStreamingAssistant(conversations, "sess-1", ["stale active state"], 100);
    sessionCache.set("sess-1", cachedSession(false));
    expect(streamingContentKeys(conversations, "sess-1")).toEqual(["text:stale active state"]);

    unsubscribe();

    expect(conversations.get("sess-1")).toMatchObject({
      messages: [],
      hasEarlierMessages: false,
      streamingAssistants: [],
    });
  });
});
