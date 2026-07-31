import { describe, expect, test } from "bun:test";
import {
  applyChatEvent,
  initialChatState,
  type AssistantMessage,
  type ChatEvent,
  type ChatState,
} from "../../models/chat-state.js";

function assistant(timestamp: number, content: AssistantMessage["content"] = []): AssistantMessage {
  return { role: "assistant", content, timestamp };
}

function applyEvents(events: ChatEvent[]): ChatState {
  return events.reduce(applyChatEvent, initialChatState());
}

describe("assistant snapshot streams", () => {
  test("a complete snapshot replaces prior content and recovers missed deltas", () => {
    const state = applyEvents([
      { type: "message_start", message: assistant(100) },
      {
        type: "message_update",
        message: assistant(100, [{ type: "text", text: "partial" }]),
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      },
      {
        type: "message_update",
        message: assistant(100, [{ type: "text", text: "complete after missed updates" }]),
        assistantMessageEvent: { type: "text_delta", delta: "updates" },
      },
    ]);

    expect(state.streamingAssistants).toEqual([{
      message: assistant(100, [{ type: "text", text: "complete after missed updates" }]),
      toolExecutions: {},
    }]);
  });

  test("message_update creates a group when message_start was missed", () => {
    const state = applyEvents([{
      type: "message_update",
      message: assistant(100, [{ type: "text", text: "recovered" }]),
      assistantMessageEvent: { type: "snapshot" },
    }]);

    expect(state.streamingAssistants.map(({ message }) => message.content)).toEqual([
      [{ type: "text", text: "recovered" }],
    ]);
  });

  test("preserves multiple assistant groups and their content order", () => {
    const state = applyEvents([
      { type: "message_end", message: assistant(200, [{ type: "text", text: "first" }]) },
      {
        type: "message_update",
        message: assistant(100, [
          { type: "text", text: "second" },
          { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } },
          { type: "text", text: "after" },
        ]),
        assistantMessageEvent: { type: "snapshot" },
      },
    ]);

    expect(state.streamingAssistants.map(({ message }) => message.content)).toEqual([
      [{ type: "text", text: "first" }],
      [
        { type: "text", text: "second" },
        { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } },
        { type: "text", text: "after" },
      ],
    ]);
  });

  test("ignores Pi user and tool-result message lifecycles", () => {
    const user = { role: "user" as const, content: "hello", timestamp: 100 };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "result" }],
      isError: false,
      timestamp: 200,
    };
    const state = applyEvents([
      { type: "message_start", message: user },
      { type: "message_update", message: toolResult, assistantMessageEvent: { type: "snapshot" } },
      { type: "message_end", message: toolResult },
    ]);

    expect(state.streamingAssistants).toEqual([]);
  });

  test("tool execution state overlays the matching snapshot tool call", () => {
    const message = assistant(100, [
      { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
    ]);
    const state = applyEvents([
      { type: "message_update", message, assistantMessageEvent: { type: "snapshot" } },
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "tc-1", toolName: "bash", args: { timeout: 10 }, partialResult: {} },
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      },
    ]);

    expect(state.streamingAssistants[0]?.toolExecutions["tc-1"]).toMatchObject({
      id: "tc-1",
      args: { command: "ls", timeout: 10 },
      status: "done",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });
  });

  test("snapshot replacement drops overlays for tool calls no longer present", () => {
    const withTool = assistant(100, [
      { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
    ]);
    const state = applyEvents([
      { type: "message_update", message: withTool, assistantMessageEvent: { type: "snapshot" } },
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } },
      {
        type: "message_update",
        message: assistant(100, [{ type: "text", text: "replacement" }]),
        assistantMessageEvent: { type: "snapshot" },
      },
    ]);

    expect(state.streamingAssistants[0]?.toolExecutions).toEqual({});
  });

  test("unknown tool events do not create or modify streaming assistants", () => {
    const initial = applyEvents([{
      type: "message_update",
      message: assistant(100, [{ type: "text", text: "safe" }]),
      assistantMessageEvent: { type: "snapshot" },
    }]);
    const next = applyChatEvent(initial, {
      type: "tool_execution_end",
      toolCallId: "unknown",
      toolName: "bash",
      isError: true,
    });

    expect(next).toBe(initial);
  });
});

describe("other chat events", () => {
  test("ChatState contains presentation state only", () => {
    expect(initialChatState()).not.toHaveProperty("isStreaming");
  });

  test("agent_start and agent_settled are presentation no-ops", () => {
    const before = applyEvents([{
      type: "message_end",
      message: assistant(100, [{ type: "text", text: "earlier turn" }]),
    }]);

    expect(applyChatEvent(before, { type: "agent_start" })).toBe(before);
    expect(applyChatEvent(before, { type: "agent_settled" })).toBe(before);
  });

  test("agent_end promotes final assistants and tool results before clearing live overlays", () => {
    const snapshot = assistant(100, [
      { type: "text", text: "answer" },
      { type: "toolCall", id: "tc-1", name: "read", arguments: {} },
    ]);
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "result" }],
      isError: false,
      timestamp: 200,
    };
    let state = applyEvents([
      { type: "message_end", message: snapshot },
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} },
    ]);
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: [{ role: "user", content: "prompt", timestamp: 1 }, snapshot, toolResult],
    });

    expect(state.streamingAssistants).toEqual([]);
    expect(state.messages).toEqual([snapshot, toolResult]);
  });

  test("agent_end recovers missed assistant lifecycles and deduplicates final messages", () => {
    const finalAssistant = assistant(100, [{ type: "text", text: "recovered final answer" }]);
    const originalToolResult = {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "original" }],
      isError: false,
      timestamp: 200,
    };
    const duplicateToolResult = { ...originalToolResult, content: [{ type: "text" as const, text: "duplicate" }], timestamp: 300 };
    const state = applyEvents([
      { type: "agent_end", messages: [finalAssistant, originalToolResult] },
      { type: "agent_end", messages: [finalAssistant, duplicateToolResult] },
    ]);

    expect(state.messages).toEqual([finalAssistant, originalToolResult]);
  });

  test("agent_end surfaces assistant errors without displaying an empty assistant", () => {
    const state = applyEvents([{
      type: "agent_end",
      messages: [{
        ...assistant(100),
        stopReason: "error",
        errorMessage: "overloaded",
      }],
    }]);

    expect(state.errorMessage).toBe("overloaded");
    expect(state.messages).toEqual([]);
  });

  test("compaction presentation remains independent of agent activity boundaries", () => {
    let state = applyChatEvent(initialChatState(), { type: "compaction_start", reason: "threshold" });
    expect(state.isCompacting).toBe(true);

    state = applyChatEvent(state, { type: "agent_start" });
    state = applyChatEvent(state, { type: "agent_end" });
    state = applyChatEvent(state, { type: "agent_settled" });
    expect(state.isCompacting).toBe(true);

    state = applyChatEvent(state, { type: "compaction_end", result: { summary: "summary" }, aborted: false });
    expect(state.isCompacting).toBe(false);
    expect(state.messages[0]).toMatchObject({ role: "compactionSummary", content: "summary" });
  });

  test("retry events update presentation state", () => {
    let state = applyEvents([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "busy" },
    ]);
    expect(state.errorMessage).toContain("Retrying");

    state = applyChatEvent(state, { type: "auto_retry_end", success: true, attempt: 1 });
    expect(state.errorMessage).toBe("");
  });
});
