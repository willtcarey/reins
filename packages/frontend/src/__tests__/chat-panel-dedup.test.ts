/**
 * Tests for chat state event handling — especially message deduplication.
 *
 * Tests the pure applyChatEvent reducer directly, no mocks needed.
 */
import { describe, test, expect } from "bun:test";
import { applyChatEvent, initialChatState, type ChatState, type AgentMessage, type UserMessage, type AssistantMessage, type ToolResultMessage } from "../models/chat-state.js";

function makeUserMsg(text: string, ts = 1000): UserMessage {
  return { role: "user" as const, content: text, timestamp: ts };
}

function makeAssistantMsg(text: string, ts = 2000): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    timestamp: ts,
  };
}

function makeToolResultMsg(id: string, text: string, ts = 3000): ToolResultMessage {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: ts,
  };
}

/** Helper: apply a sequence of events to a state. */
function applyEvents(state: ChatState, events: any[]): ChatState {
  return events.reduce((s, e) => applyChatEvent(s, e), state);
}

// ---------------------------------------------------------------------------

describe("applyChatEvent — agent_end deduplication", () => {
  // event.messages from the agent SDK contains only the messages produced
  // during the current run (user prompts + assistant + tool results), NOT
  // the full conversation history.

  test("agent_end appends new non-user messages normally", () => {
    // Existing conversation history
    const oldUser = makeUserMsg("older question", 100);
    const oldAssistant = makeAssistantMsg("older answer", 200);

    // This run's user prompt (added optimistically)
    const newUser = makeUserMsg("hello", 1000);
    const newAssistant = makeAssistantMsg("hi there", 2000);
    const newTool = makeToolResultMsg("tc1", "output", 3000);

    const messages: AgentMessage[] = [oldUser, oldAssistant, newUser];
    let state: ChatState = {
      ...initialChatState(),
      messages,
    };
    state = applyChatEvent(state, { type: "agent_start" });

    // agent_end with this run's messages
    const runMessages: AgentMessage[] = [newUser, newAssistant, newTool];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    // Should have old history + new messages, no duplicates
    expect(state.messages).toHaveLength(5);
    expect(state.messages[0]).toBe(oldUser);
    expect(state.messages[1]).toBe(oldAssistant);
    expect(state.messages[2]).toBe(newUser);
    expect(state.messages[3].role).toBe("assistant");
    expect(state.messages[4].role).toBe("toolResult");
    expect(state.isStreaming).toBe(false);
  });

  test("agent_end deduplicates when sessionData refreshed mid-run", () => {
    const oldUser = makeUserMsg("older question", 100);
    const newUser = makeUserMsg("hello", 1000);
    const assistant = makeAssistantMsg("hi there", 2000);
    const tool = makeToolResultMsg("tc1", "output", 3000);

    // Start with optimistic user message
    const startMessages: AgentMessage[] = [oldUser, newUser];
    let state: ChatState = {
      ...initialChatState(),
      messages: startMessages,
    };
    state = applyChatEvent(state, { type: "agent_start" });

    // Simulate sessionData refresh mid-run (reconnect/navigation):
    // API returns the full conversation including messages the agent
    // has already produced.
    const refreshedMessages: AgentMessage[] = [oldUser, newUser, assistant, tool];
    state = {
      ...state,
      messages: refreshedMessages,
    };

    // agent_end arrives — event.messages has this run's messages,
    // which overlap with what sessionData already populated.
    const runMessages: AgentMessage[] = [newUser, assistant, tool];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    // No duplicates
    expect(state.messages).toHaveLength(4);
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(state.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  test("agent_end with undefined messages preserves existing messages", () => {
    const user = makeUserMsg("hello");
    const messages: AgentMessage[] = [user];
    let state = { ...initialChatState(), messages };
    state = applyChatEvent(state, { type: "agent_start" });
    state = applyChatEvent(state, { type: "agent_end" });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toBe(user);
  });

  test("multiple sessionData refreshes during streaming don't cause duplication", () => {
    const user = makeUserMsg("do stuff", 1000);
    const asst1 = makeAssistantMsg("step 1", 2000);
    const tool1 = makeToolResultMsg("t1", "result 1", 3000);
    const asst2 = makeAssistantMsg("step 2", 4000);

    const startMessages: AgentMessage[] = [user];
    let state = { ...initialChatState(), messages: startMessages };
    state = applyChatEvent(state, { type: "agent_start" });

    // First reconnect refresh — partial results already in messages
    const refresh1: AgentMessage[] = [user, asst1, tool1];
    state = { ...state, messages: refresh1 };

    // Second reconnect refresh — even more results
    const refresh2: AgentMessage[] = [user, asst1, tool1, asst2];
    state = { ...state, messages: refresh2 };

    // agent_end with all run messages
    const runMessages: AgentMessage[] = [user, asst1, tool1, asst2];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    expect(state.messages).toHaveLength(4);
  });

  test("agent_end preserves history from before the current run", () => {
    // Full prior conversation
    const hist1 = makeUserMsg("first question", 100);
    const hist2 = makeAssistantMsg("first answer", 200);
    const hist3 = makeUserMsg("second question", 300);
    const hist4 = makeAssistantMsg("second answer", 400);

    // New run
    const newUser = makeUserMsg("third question", 1000);
    const newAssistant = makeAssistantMsg("third answer", 2000);

    const allMessages: AgentMessage[] = [hist1, hist2, hist3, hist4, newUser];
    let state: ChatState = {
      ...initialChatState(),
      messages: allMessages,
    };
    state = applyChatEvent(state, { type: "agent_start" });
    const runMessages: AgentMessage[] = [newUser, newAssistant];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    // All history preserved + new assistant appended
    expect(state.messages).toHaveLength(6);
    expect(state.messages[0]).toBe(hist1);
    expect(state.messages[4]).toBe(newUser);
    expect(state.messages[5].role).toBe("assistant");
  });
});

describe("applyChatEvent — other event types", () => {
  test("agent_start sets streaming and clears blocks", () => {
    const state = applyChatEvent(initialChatState(), { type: "agent_start" });
    expect(state.isStreaming).toBe(true);
    expect(state.streamingBlocks).toEqual([]);
  });

  test("message_update text_delta appends to last text block", () => {
    let state = applyChatEvent(initialChatState(), { type: "agent_start" });
    state = applyChatEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    state = applyChatEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });

    expect(state.streamingBlocks).toHaveLength(1);
    expect(state.streamingBlocks[0]).toEqual({ type: "text", text: "Hello world" });
  });

  test("tool_execution_start adds running tool block", () => {
    let state = applyChatEvent(initialChatState(), { type: "agent_start" });
    state = applyChatEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    });

    expect(state.streamingBlocks).toHaveLength(1);
    expect(state.streamingBlocks[0]).toMatchObject({
      type: "tool",
      id: "tc1",
      name: "bash",
      status: "running",
    });
  });

  test("tool_execution_update updates args for running tool block", () => {
    let state = applyEvents(initialChatState(), [
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} },
    ]);

    state = applyChatEvent(state, {
      type: "tool_execution_update",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls -la" },
      partialResult: {},
    });

    expect(state.streamingBlocks[0]).toMatchObject({
      type: "tool",
      id: "tc1",
      name: "bash",
      args: { command: "ls -la" },
      status: "running",
    });
  });

  test("tool_execution_end marks tool block done", () => {
    let state = applyEvents(initialChatState(), [
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} },
    ]);
    state = applyChatEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "output" }] },
      isError: false,
    });

    expect(state.streamingBlocks[0]).toMatchObject({ status: "done", isError: false });
  });

  test("compaction_end appends marker when not aborted", () => {
    let state = applyChatEvent(initialChatState(), { type: "compaction_start" });
    expect(state.isCompacting).toBe(true);

    state = applyChatEvent(state, {
      type: "compaction_end",
      aborted: false,
      result: { summary: "Summarized" },
    });

    expect(state.isCompacting).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("compactionSummary");
  });

  test("compaction_end does not append marker when aborted", () => {
    let state = applyChatEvent(initialChatState(), { type: "compaction_start" });
    state = applyChatEvent(state, { type: "compaction_end", aborted: true });

    expect(state.isCompacting).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  test("user_message appends a user message", () => {
    const state = applyChatEvent(initialChatState(), {
      type: "user_message",
      message: [{ type: "text", text: "hello from another client" }],
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
  });

  test("no-op event type returns state unchanged", () => {
    const state = initialChatState();
    const next = applyChatEvent(state, { type: "message_end" });
    expect(next).toBe(state);
  });
});
