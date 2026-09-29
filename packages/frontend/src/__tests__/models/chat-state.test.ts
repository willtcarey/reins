import { describe, expect, test } from "bun:test";
import {
  applyChatEvent,
  initialChatState,
  markStreamsStale,
  type AssistantStreamEvent,
  type ChatEvent,
  type ChatState,
} from "../../models/chat-state.js";
import type { AssistantMessage } from "../../models/agent-message.js";

function assistant(timestamp: number, content: AssistantMessage["content"] = []): AssistantMessage {
  return { role: "assistant", content, timestamp };
}

function applyEvents(events: ChatEvent[], state: ChatState = initialChatState()): ChatState {
  return events.reduce(applyChatEvent, state);
}

/** A thin update: Pi's step with no snapshot. */
function step(streamId: string, assistantMessageEvent: AssistantStreamEvent): ChatEvent {
  return { type: "message_update", streamId, assistantMessageEvent };
}

/** An update that carries the full message after its step. */
function keyframe(streamId: string, message: AssistantMessage, assistantMessageEvent: AssistantStreamEvent = { type: "text_start", contentIndex: 0 }): ChatEvent {
  return { type: "message_update", streamId, message, assistantMessageEvent };
}

describe("assistant streams", () => {
  test("deltas grow the addressed block from its start keyframe; *_end is authoritative", () => {
    const toolCall = { type: "toolCall" as const, id: "tc-1", name: "read", arguments: {} };
    const state = applyEvents([
      { type: "message_start", streamId: "s", message: assistant(100) },
      keyframe("s", assistant(100, [{ type: "thinking", thinking: "" }]), { type: "thinking_start", contentIndex: 0 }),
      step("s", { type: "thinking_delta", contentIndex: 0, delta: "hm" }),
      step("s", { type: "thinking_delta", contentIndex: 0, delta: "m" }),
      step("s", { type: "thinking_end", contentIndex: 0, content: "hmm." }),
      keyframe("s", assistant(100, [{ type: "thinking", thinking: "hmm." }, { type: "text", text: "" }]), { type: "text_start", contentIndex: 1 }),
      step("s", { type: "text_delta", contentIndex: 1, delta: "Hel" }),
      step("s", { type: "text_delta", contentIndex: 1, delta: "lo" }),
      keyframe("s", assistant(100, [{ type: "thinking", thinking: "hmm." }, { type: "text", text: "Hello" }, { ...toolCall, partialJson: "" }]), { type: "toolcall_start", contentIndex: 2 }),
      step("s", { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' }),
      step("s", { type: "toolcall_delta", contentIndex: 2, delta: '"a.ts"}' }),
    ]);

    // The raw argument JSON accumulates; parsed arguments wait for toolcall_end.
    expect(state.streamingAssistants[0]!.message.content).toEqual([
      { type: "thinking", thinking: "hmm." },
      { type: "text", text: "Hello" },
      { ...toolCall, partialJson: '{"path":"a.ts"}' },
    ]);

    const ended = applyEvents([
      step("s", { type: "text_end", contentIndex: 1, content: "Hello!" }),
      step("s", { type: "toolcall_end", contentIndex: 2, toolCall: { ...toolCall, arguments: { path: "a.ts" } } }),
    ], state);
    expect(ended.streamingAssistants[0]!.message.content).toEqual([
      { type: "thinking", thinking: "hmm." },
      { type: "text", text: "Hello!" },
      { ...toolCall, arguments: { path: "a.ts" } },
    ]);
  });

  test("a keyframe replaces the overlay and a later message_end is authoritative", () => {
    const state = applyEvents([
      keyframe("s", assistant(100, [{ type: "text", text: "par" }])),
      step("s", { type: "text_delta", contentIndex: 0, delta: "tial" }),
      keyframe("s", assistant(100, [{ type: "text", text: "partial and more" }]), { type: "text_delta", contentIndex: 0, delta: "more" }),
    ]);
    expect(state.streamingAssistants).toEqual([{ streamId: "s", message: assistant(100, [{ type: "text", text: "partial and more" }]), toolExecutions: {} }]);

    const ended = applyChatEvent(state, { type: "message_end", streamId: "s", entryId: "e-1", message: assistant(100, [{ type: "text", text: "final" }]) });
    expect(ended.streamingAssistants).toEqual([{ streamId: "s", durableId: "e-1", message: assistant(100, [{ type: "text", text: "final" }]), toolExecutions: {} }]);
  });

  test("a delta for an unknown stream is ignored until a keyframe shows the message", () => {
    const initial = initialChatState();
    expect(applyChatEvent(initial, step("late", { type: "text_delta", contentIndex: 0, delta: "lost" }))).toBe(initial);

    const state = applyEvents([
      keyframe("late", assistant(100, [{ type: "text", text: "caught up" }]), { type: "text_delta", contentIndex: 0, delta: "up" }),
      step("late", { type: "text_delta", contentIndex: 0, delta: "!" }),
    ]);
    expect(state.streamingAssistants[0]!.message.content).toEqual([{ type: "text", text: "caught up!" }]);
  });

  test("a stale overlay keeps its content and ignores deltas until the next keyframe or message_end", () => {
    const live = applyEvents([
      keyframe("s", assistant(100, [{ type: "text", text: "before" }])),
      step("s", { type: "text_delta", contentIndex: 0, delta: " gap" }),
    ]);
    const stale = markStreamsStale(live);
    expect(stale.streamingAssistants[0]!.message).toBe(live.streamingAssistants[0]!.message);
    expect(markStreamsStale(stale)).toBe(stale);

    const ignored = applyChatEvent(stale, step("s", { type: "text_delta", contentIndex: 0, delta: " wrong" }));
    expect(ignored).toBe(stale);

    const recovered = applyEvents([
      keyframe("s", assistant(100, [{ type: "text", text: "before gap and after" }]), { type: "text_delta", contentIndex: 0, delta: "after" }),
      step("s", { type: "text_delta", contentIndex: 0, delta: "!" }),
    ], stale);
    expect(recovered.streamingAssistants).toEqual([{ streamId: "s", message: assistant(100, [{ type: "text", text: "before gap and after!" }]), toolExecutions: {} }]);

    const ended = applyChatEvent(stale, { type: "message_end", streamId: "s", message: assistant(100, [{ type: "text", text: "done" }]) });
    expect(ended.streamingAssistants[0]).toEqual({ streamId: "s", message: assistant(100, [{ type: "text", text: "done" }]), toolExecutions: {} });
  });

  test("a delta that does not fit the overlay's content marks it stale instead of guessing", () => {
    const live = applyEvents([keyframe("s", assistant(100, [{ type: "text", text: "text" }]))]);
    for (const mismatch of [
      step("s", { type: "thinking_delta", contentIndex: 0, delta: "x" }),
      step("s", { type: "text_delta", contentIndex: 3, delta: "x" }),
      // A block start always comes with a keyframe; without one the block's identity is unknown.
      step("s", { type: "toolcall_start", contentIndex: 1 }),
    ]) {
      const next = applyChatEvent(live, mismatch);
      expect(next.streamingAssistants[0]).toEqual({ ...live.streamingAssistants[0]!, stale: true });
    }
  });

  test("preserves multiple assistant groups and their content order", () => {
    const state = applyEvents([
      { type: "message_end", streamId: "stream-1", message: assistant(200, [{ type: "text", text: "first" }]) },
      keyframe("stream-2", assistant(100, [
        { type: "text", text: "second" },
        { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } },
        { type: "text", text: "after" },
      ])),
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
      { type: "message_start", streamId: "user-stream", message: user },
      { type: "message_start", streamId: "tool-stream", message: toolResult },
      { type: "message_end", streamId: "tool-stream", message: toolResult },
    ]);

    expect(state.streamingAssistants).toEqual([]);
  });

  test("tool execution state overlays the matching snapshot tool call", () => {
    const message = assistant(100, [
      { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
    ]);
    const state = applyEvents([
      keyframe("stream-1", message, { type: "toolcall_start", contentIndex: 0 }),
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
      keyframe("stream-1", withTool, { type: "toolcall_start", contentIndex: 0 }),
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } },
      keyframe("stream-1", assistant(100, [{ type: "text", text: "replacement" }])),
    ]);

    expect(state.streamingAssistants[0]?.toolExecutions).toEqual({});
  });

  test("unknown tool events do not create or modify streaming assistants", () => {
    const initial = applyEvents([keyframe("stream-1", assistant(100, [{ type: "text", text: "safe" }]))]);
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
    expect(initialChatState()).toEqual({ streamingAssistants: [], isCompacting: false, errorMessage: "" });
  });

  test("agent_start is a presentation no-op", () => {
    const before = applyEvents([{
      type: "message_end",
      streamId: "stream-1",
      message: assistant(100, [{ type: "text", text: "earlier turn" }]),
    }]);

    expect(applyChatEvent(before, { type: "agent_start" })).toBe(before);
  });

  test("agent_end clears streaming overlays without promoting a second transcript", () => {
    const snapshot = assistant(100, [{ type: "text", text: "answer" }]);
    let state = applyEvents([{ type: "message_end", streamId: "stream-1", message: snapshot }]);
    state = applyChatEvent(state, { type: "agent_end", messages: [snapshot] });

    expect(state).toEqual(initialChatState());
  });

  test("agent_end surfaces authoritative run errors without displaying an empty assistant", () => {
    const state = applyEvents([{
      type: "agent_end",
      messages: [{
        ...assistant(100),
        stopReason: "error",
        errorMessage: "stale transcript error",
      }],
      runId: "run-1",
      status: "failed",
      error: { code: "provider_error", message: "overloaded" },
    }]);

    expect(state.errorMessage).toBe("overloaded");
    expect(state.streamingAssistants).toEqual([]);
  });

  test("compaction presentation remains independent of agent activity boundaries", () => {
    let state = applyChatEvent(initialChatState(), { type: "compaction_start", reason: "threshold" });
    expect(state.isCompacting).toBe(true);

    state = applyChatEvent(state, { type: "agent_start" });
    state = applyChatEvent(state, { type: "agent_end" });
    expect(state.isCompacting).toBe(true);

    state = applyChatEvent(state, { type: "compaction_end", result: { summary: "summary" }, aborted: false });
    expect(state.isCompacting).toBe(false);
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
