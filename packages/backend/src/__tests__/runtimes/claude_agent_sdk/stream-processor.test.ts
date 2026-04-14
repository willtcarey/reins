import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeEvent } from "../../../runtimes/registry.js";
import { ClaudeStreamProcessor } from "../../../runtimes/claude_agent_sdk/stream-processor.js";
import { COMPACTION_NOTICE } from "../../../runtimes/claude_agent_sdk/events.js";

/**
 * Build a partial SDKMessage for testing. The event mapper only reads
 * fields relevant to each message type — required SDK metadata like
 * uuid/session_id is unused and safely omitted.
 */
function sdkMsg(partial: Record<string, unknown>): SDKMessage {
  return partial as SDKMessage;
}

/**
 * Stream a tool_use block through content_block_start → input_json_delta → content_block_stop
 * so the processor tracks it internally. Returns all emitted events.
 */
function streamToolCall(processor: ClaudeStreamProcessor, opts: {
  index?: number;
  id: string;
  sdkName: string;
  inputJson: string;
}) {
  const { index = 0, id, sdkName, inputJson } = opts;
  const events = [
    ...processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name: sdkName, input: {} },
      },
    })),
    ...processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: inputJson },
      },
    })),
    ...processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "content_block_stop", index },
    })),
  ];
  return events;
}

describe("claude stream processor", () => {
  test("maps text deltas and result to runtime-compatible lifecycle events", () => {
    const processor = new ClaudeStreamProcessor();

    const start = processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
    }));

    const delta = processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    }));

    const messageStop = processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "message_stop" },
    }));

    const result = processor.process(sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
    }));

    expect(start.map((event) => event.type)).toEqual(["agent_start", "turn_start", "message_start"]);
    expect(delta).toEqual([
      expect.objectContaining({
        type: "message_update",
        message: expect.objectContaining({ role: "assistant" }),
        assistantMessageEvent: expect.objectContaining({ type: "text_delta", delta: "Hello" }),
      }),
    ]);
    expect(messageStop).toEqual([]);
    expect(result.map((event) => event.type)).toEqual(["message_end", "turn_end", "agent_end"]);
  });

  test("surfaces tool calls only at content_block_stop with finalized args", () => {
    const processor = new ClaudeStreamProcessor();

    const start = processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc1", name: "Read", input: {} },
      },
    }));

    expect(start.map((event) => event.type)).toEqual(["agent_start", "turn_start", "message_start"]);
    expect(start.some((event) => event.type === "tool_execution_start")).toBe(false);

    const partial1 = processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      },
    }));

    const partial2 = processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'path":"/foo.ts"}' },
      },
    }));

    expect(partial1).toEqual([]);
    expect(partial2).toEqual([]);
    // No tool_execution_start emitted yet — args not finalized until content_block_stop

    const stop = processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    expect(stop).toEqual([
      expect.objectContaining({
        type: "tool_execution_start",
        toolCallId: "tc1",
        toolName: "read",
        args: { path: "/foo.ts" },
      }),
    ]);

    // Verify the assistant message content reflects the finalized tool call
    // by completing the turn and inspecting the agent_end event
    processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    }));
    const result = processor.process(sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "tool_use",
    }));
    const agentEnd = result.find((event) => event.type === "agent_end");
    if (agentEnd?.type === "agent_end") {
      expect(agentEnd.messages[0].content).toEqual([
        expect.objectContaining({
          type: "toolCall",
          id: "tc1",
          name: "read",
          arguments: { path: "/foo.ts" },
        }),
      ]);
    }
  });

  test("ignores assistant snapshot messages for websocket streaming", () => {
    const processor = new ClaudeStreamProcessor();

    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc1", name: "Bash", input: {} },
      },
    }));
    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' },
      },
    }));

    const snapshotEvents = processor.process(sdkMsg({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc1", name: "Bash", input: { command: "echo hi" } },
        ],
        stop_reason: "tool_use",
      },
    }));

    expect(snapshotEvents).toEqual([]);

    const freshProcessor = new ClaudeStreamProcessor();
    const assistantOnlyEvents = freshProcessor.process(sdkMsg({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "snapshot only" }],
        stop_reason: "end_turn",
      },
    }));

    expect(assistantOnlyEvents).toEqual([]);
  });

  test("message_start closes previous turn and emits intermediate boundary", () => {
    const processor = new ClaudeStreamProcessor();

    // Turn 1: tool_use → tool_result
    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tc1", name: "Read", input: {} },
      },
    }));
    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/foo.ts"}' },
      },
    }));
    processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    // Tool result arrives before message_start (realistic SDK ordering)
    const toolResultEvents = processor.process(sdkMsg({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc1", content: [{ type: "text", text: "ok" }] }],
      },
      parent_tool_use_id: null,
    }));

    expect(toolResultEvents).toEqual([
      expect.objectContaining({ type: "tool_execution_end", toolCallId: "tc1" }),
    ]);

    // Turn 2 begins — message_start closes the previous turn
    const nextMessageStart = processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_2", role: "assistant", content: [] } },
    }));

    expect(nextMessageStart.map((event) => event.type)).toEqual([
      "message_end",
      "turn_end",
      "turn_start",
    ]);

    // Verify turn_end includes the tool result from the previous turn
    const turnEnd = nextMessageStart.find((event) => event.type === "turn_end");
    if (turnEnd?.type === "turn_end") {
      expect(turnEnd.toolResults).toHaveLength(1);
      expect(turnEnd.toolResults[0]).toEqual(expect.objectContaining({
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
      }));
    }
  });

  test("maps tool_progress using tracked args", () => {
    const processor = new ClaudeStreamProcessor();

    // Set up a tracked tool call via the stream event path
    streamToolCall(processor, {
      id: "tc1",
      sdkName: "Bash",
      inputJson: '{"command":"pwd"}',
    });

    const events = processor.process(sdkMsg({
      type: "tool_progress",
      tool_use_id: "tc1",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
    }));

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_execution_update",
        toolCallId: "tc1",
        toolName: "bash",
        args: { command: "pwd" },
        partialResult: { elapsedTimeSeconds: 2 },
      }),
    ]);
  });

  test("user tool_result emits tool_execution_end with result content", () => {
    const processor = new ClaudeStreamProcessor();

    // Set up a tracked tool call via the stream event path
    streamToolCall(processor, {
      id: "toolu_1",
      sdkName: "Read",
      inputJson: '{"file_path":"/test.txt"}',
    });

    const events = processor.process(sdkMsg({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "file contents here" }],
          },
        ],
      },
      parent_tool_use_id: null,
      tool_use_result: "file contents here",
    }));

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "toolu_1",
        toolName: "read",
        result: { content: [{ type: "text", text: "file contents here" }] },
        isError: false,
      }),
    ]);

    // Verify tool result is included in turn_end by completing the turn
    processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    }));
    const resultEvents = processor.process(sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "tool_use",
    }));
    const turnEnd = resultEvents.find((event) => event.type === "turn_end");
    expect(turnEnd).toBeDefined();
    if (turnEnd?.type === "turn_end") {
      expect(turnEnd.toolResults).toHaveLength(1);
      expect(turnEnd.toolResults[0]).toEqual(expect.objectContaining({
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "read",
      }));
    }
  });

  test("user error tool_result sets isError", () => {
    const processor = new ClaudeStreamProcessor();

    // Set up a tracked tool call via the stream event path
    streamToolCall(processor, {
      id: "toolu_1",
      sdkName: "Read",
      inputJson: '{"file_path":"/missing.txt"}',
    });

    const events = processor.process(sdkMsg({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "Error: file not found" }],
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
    }));

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "toolu_1",
        toolName: "read",
        isError: true,
      }),
    ]);
  });

  test("keeps agent_end tied to result, not message_stop", () => {
    const processor = new ClaudeStreamProcessor();

    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
    }));
    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done" },
      },
    }));

    const stopEvents = processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "message_stop" },
    }));
    const resultEvents = processor.process(sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
    }));

    expect(stopEvents).toEqual([]);
    expect(resultEvents.map((event) => event.type)).toEqual(["message_end", "turn_end", "agent_end"]);
  });

  test("replays the canonical live path: stream_event + user(tool_result) + result", () => {
    const processor = new ClaudeStreamProcessor();

    const eventTypes: string[] = [];
    const apply = (message: SDKMessage) => {
      const events = processor.process(message);
      eventTypes.push(...events.map((event) => event.type));
      return events;
    };

    apply(sdkMsg({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } },
    }));
    apply(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_read", name: "Read", input: {} },
      },
    }));

    const partial = apply(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/test.txt"}' },
      },
    }));
    expect(partial).toEqual([]);

    const toolStart = apply(sdkMsg({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));
    expect(toolStart).toEqual([
      expect.objectContaining({
        type: "tool_execution_start",
        toolCallId: "toolu_read",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
    ]);

    apply(sdkMsg({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    }));
    apply(sdkMsg({
      type: "stream_event",
      event: { type: "message_stop" },
    }));

    const snapshot = apply(sdkMsg({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/test.txt" } }],
        stop_reason: "tool_use",
      },
    }));
    expect(snapshot).toEqual([]);

    const toolEnd = apply(sdkMsg({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "text", text: "hello" }] }],
      },
      parent_tool_use_id: null,
    }));
    expect(toolEnd).toEqual([
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "toolu_read",
        toolName: "read",
        result: { content: [{ type: "text", text: "hello" }] },
      }),
    ]);

    apply(sdkMsg({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_2", role: "assistant", content: [] } },
    }));
    apply(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    }));
    apply(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done." },
      },
    }));
    apply(sdkMsg({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
    }));
    apply(sdkMsg({
      type: "stream_event",
      event: { type: "message_stop" },
    }));

    const result = apply(sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
    }));

    expect(eventTypes).toEqual([
      // Turn 1: tool_use + tool_result
      "agent_start",
      "turn_start",
      "message_start",
      "tool_execution_start",
      "tool_execution_end",
      // Intermediate boundary at message_start (turn 2)
      "message_end",
      "turn_end",
      "turn_start",
      // Turn 2: text response
      "message_start",
      "message_update",
      // Final result
      "message_end",
      "turn_end",
      "agent_end",
    ]);

    const agentEnd = result.find((event) => event.type === "agent_end");
    expect(agentEnd).toBeDefined();
    if (agentEnd?.type === "agent_end") {
      // agent_end.messages includes all turns: intermediate + final
      expect(agentEnd.messages).toHaveLength(3);
      expect(agentEnd.messages[0].content).toEqual([
        { type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "/tmp/test.txt" } },
      ]);
      expect(agentEnd.messages[1]).toEqual(expect.objectContaining({
        role: "toolResult",
        toolCallId: "toolu_read",
        toolName: "read",
      }));
      expect(agentEnd.messages[2].content).toEqual([
        { type: "text", text: "Done." },
      ]);
    }
  });

  test("maps compact boundary into unified compaction lifecycle", () => {
    const processor = new ClaudeStreamProcessor();

    const events = processor.process(sdkMsg({
      type: "system",
      subtype: "compact_boundary",
    }));

    expect(events).toEqual([
      { type: "compaction_start", reason: "claude_sdk_compact_boundary" },
      { type: "compaction_end", result: { summary: COMPACTION_NOTICE }, aborted: false },
    ]);
  });

  test("accumulates thinking deltas into a thinking block", () => {
    const processor = new ClaudeStreamProcessor();

    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
    }));
    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think about " },
      },
    }));
    processor.process(sdkMsg({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "this problem." },
      },
    }));

    // Complete the turn and verify accumulated thinking in the agent_end message
    processor.process(sdkMsg({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
    }));
    const resultEvents = processor.process(sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
    }));

    const agentEnd = resultEvents.find((event) => event.type === "agent_end");
    expect(agentEnd).toBeDefined();
    if (agentEnd?.type === "agent_end") {
      expect(agentEnd.messages[0].content).toEqual([
        { type: "thinking", thinking: "Let me think about this problem." },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Trace fixture replay tests
// ---------------------------------------------------------------------------

interface TraceFixture {
  version: number;
  toolPlan: {
    readPath: string;
    bashCommand: string;
  };
  sdkMessages: unknown[];
  summary: {
    sdkMessageTypes: string[];
    toolCallIds: string[];
    assistantSnapshotCount: number;
    userToolResultCount: number;
    resultSubtype: string | null;
    finalResultText: string;
  };
}

async function loadFixture(): Promise<TraceFixture> {
  const path = new URL("./fixtures/tool-trace.json", import.meta.url);
  return await Bun.file(path).json();
}

interface ReplayEntry {
  sdkMessage: unknown;
  sdkType: string;
  events: AgentRuntimeEvent[];
}

function replayFixture(fixture: TraceFixture): ReplayEntry[] {
  const processor = new ClaudeStreamProcessor();

  return fixture.sdkMessages.map((sdkMessage, i) => ({
    sdkMessage,
    sdkType: fixture.summary.sdkMessageTypes[i] ?? "unknown",
    events: processor.process(sdkMessage as SDKMessage),
  }));
}

describe("trace fixture replay", () => {
  test("stores raw sdk messages plus a light sdk-derived summary only", async () => {
    const fixture = await loadFixture();

    expect(fixture.version).toBe(2);
    expect(fixture.sdkMessages.length).toBeGreaterThan(0);
    expect(fixture.summary.sdkMessageTypes).toHaveLength(fixture.sdkMessages.length);
    expect(fixture.summary.assistantSnapshotCount).toBeGreaterThan(0);
    expect(fixture.summary.userToolResultCount).toBe(2);
    expect(fixture.summary.resultSubtype).toBe("success");
    expect(fixture.summary.finalResultText.length).toBeGreaterThan(0);

    expect(fixture).not.toHaveProperty("runtimeEvents");
    expect(fixture).not.toHaveProperty("sessionMessages");
    expect(fixture).not.toHaveProperty("transformedSessionMessages");
  });

  test("captures multiple sdk message_start/message_stop pairs before the final result", async () => {
    const fixture = await loadFixture();

    expect(fixture.summary.sdkMessageTypes.filter((type) => type === "stream_event.message_start")).toHaveLength(2);
    expect(fixture.summary.sdkMessageTypes.filter((type) => type === "stream_event.message_stop")).toHaveLength(2);
    expect(fixture.summary.sdkMessageTypes.at(-1)).toBe("result.success");
    expect(fixture.summary.sdkMessageTypes.filter((type) => type === "user")).toHaveLength(2);
  });

  test("replay only emits agent_end when the result message arrives", async () => {
    const fixture = await loadFixture();
    const processor = new ClaudeStreamProcessor();

    let sawResult = false;
    let agentEndCount = 0;

    for (const sdkMessage of fixture.sdkMessages) {
      const typedMessage = sdkMessage as { type?: string };
      if (typedMessage.type === "result") sawResult = true;

      const events = processor.process(sdkMessage as SDKMessage);
      for (const event of events) {
        if (event.type !== "agent_end") continue;
        agentEndCount += 1;
        expect(sawResult).toBe(true);
      }
    }

    expect(agentEndCount).toBe(1);
  });

  test("replay ignores assistant snapshots and uses user tool_result messages as tool_execution_end", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);

    const assistantEntries = perMessage.filter(({ sdkMessage }) => (sdkMessage as { type?: string }).type === "assistant");
    expect(assistantEntries).toHaveLength(fixture.summary.assistantSnapshotCount);
    expect(assistantEntries.every(({ events }) => events.length === 0)).toBe(true);

    const userEntries = perMessage.filter(({ sdkMessage }) => (sdkMessage as { type?: string }).type === "user");
    expect(userEntries).toHaveLength(fixture.summary.userToolResultCount);
    expect(userEntries.map(({ events }) => events.map((event) => event.type))).toEqual([
      ["tool_execution_end"],
      ["tool_execution_end"],
    ]);
  });

  test("replay emits tool_execution_start only at content_block_stop with finalized args", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);

    const inputJsonEntries = perMessage.filter(({ sdkMessage }) => {
      const typed = sdkMessage as { type?: string; event?: { type?: string; delta?: { type?: string } } };
      return typed.type === "stream_event"
        && typed.event?.type === "content_block_delta"
        && typed.event?.delta?.type === "input_json_delta";
    });

    expect(inputJsonEntries.length).toBeGreaterThan(0);
    expect(inputJsonEntries.every(({ events }) => events.length === 0)).toBe(true);

    const toolStartEntries = perMessage.filter(({ events }) => events.some((event) => event.type === "tool_execution_start"));
    expect(toolStartEntries).toHaveLength(2);
    expect(toolStartEntries.every(({ sdkMessage }) => {
      const typed = sdkMessage as { type?: string; event?: { type?: string } };
      return typed.type === "stream_event" && typed.event?.type === "content_block_stop";
    })).toBe(true);

    type ToolStartEvent = Extract<import("../../../runtimes/registry.js").AgentRuntimeEvent, { type: "tool_execution_start" }>;
    const toolStarts = toolStartEntries.flatMap(({ events }) =>
      events.filter((event): event is ToolStartEvent => event.type === "tool_execution_start"),
    );
    expect(toolStarts.map((event) => event.toolCallId)).toEqual(fixture.summary.toolCallIds);
    expect(toolStarts.map((event) => event.toolName)).toEqual(["read", "bash"]);
    expect(basename(String(toolStarts[0]?.args?.path ?? ""))).toBe(basename(fixture.toolPlan.readPath));
    expect(toolStarts[1]?.args).toMatchObject({ command: fixture.toolPlan.bashCommand });
  });

  // ---------------------------------------------------------------------------
  // Intermediate turn boundary / persistence tests
  // ---------------------------------------------------------------------------

  test("replay emits turn_end at the intermediate boundary between SDK-internal turns", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);

    // The fixture has two message_start events: one for the tool-use turn,
    // one for the final text response turn.
    const messageStartEntries = perMessage.filter(
      ({ sdkType }) => sdkType === "stream_event.message_start",
    );
    expect(messageStartEntries).toHaveLength(2);

    // First message_start: no previous turn state → no boundary events
    expect(messageStartEntries[0].events).toEqual([]);

    // Second message_start: closes the tool-use turn → emits boundary
    const boundaryEvents = messageStartEntries[1].events;
    const boundaryTypes = boundaryEvents.map((e) => e.type);
    expect(boundaryTypes).toEqual(["message_end", "turn_end", "turn_start"]);
  });

  test("intermediate turn_end carries tool results from the completed turn", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);

    // Find the turn_end at the intermediate boundary (not the final one)
    const allEvents = perMessage.flatMap(({ events }) => events);
    const turnEnds = allEvents.filter((e) => e.type === "turn_end");

    // Should have 2 turn_ends: one intermediate, one final
    expect(turnEnds).toHaveLength(2);

    const intermediateTurnEnd = turnEnds[0];
    expect(intermediateTurnEnd.type).toBe("turn_end");
    if (intermediateTurnEnd.type !== "turn_end") return;

    // The intermediate turn had 2 tool calls (Read + Bash) → 2 tool results
    expect(intermediateTurnEnd.toolResults).toHaveLength(2);
    expect(intermediateTurnEnd.toolResults.map((r) => r.toolName)).toEqual(["read", "bash"]);
    expect(intermediateTurnEnd.toolResults.every((r) => r.role === "toolResult")).toBe(true);

    // The assistant message in the intermediate turn_end should contain the tool calls
    expect(intermediateTurnEnd.message.role).toBe("assistant");
    const content = intermediateTurnEnd.message.content;
    expect(Array.isArray(content)).toBe(true);
    const toolCalls = (content as unknown[]).filter(
      (b: unknown) => (b as Record<string, unknown>).type === "toolCall",
    );
    expect(toolCalls).toHaveLength(2);
  });

  test("agent_end includes messages from all turns (intermediate + final)", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);

    const allEvents = perMessage.flatMap(({ events }) => events);
    const agentEnds = allEvents.filter((e) => e.type === "agent_end");
    expect(agentEnds).toHaveLength(1);

    const agentEnd = agentEnds[0];
    if (agentEnd.type !== "agent_end") return;

    // Turn 1: assistant (with tool calls) + 2 tool results
    // Turn 2: assistant (with text response)
    // Total: 4 messages
    expect(agentEnd.messages).toHaveLength(4);

    // First message: assistant with tool calls from turn 1
    expect(agentEnd.messages[0].role).toBe("assistant");
    const turn1Content = agentEnd.messages[0].content;
    expect(Array.isArray(turn1Content)).toBe(true);
    const turn1ToolCalls = (turn1Content as unknown[]).filter(
      (b: unknown) => (b as Record<string, unknown>).type === "toolCall",
    );
    expect(turn1ToolCalls).toHaveLength(2);

    // Middle messages: tool results from turn 1
    expect(agentEnd.messages[1].role).toBe("toolResult");
    expect(agentEnd.messages[2].role).toBe("toolResult");

    // Last message: assistant text response from turn 2
    expect(agentEnd.messages[3].role).toBe("assistant");
    const turn2Content = agentEnd.messages[3].content;
    expect(Array.isArray(turn2Content)).toBe(true);
    const textBlocks = (turn2Content as unknown[]).filter(
      (b: unknown) => (b as Record<string, unknown>).type === "text",
    );
    expect(textBlocks.length).toBeGreaterThan(0);
    // The final text should mention the file and bash output
    const finalText = (textBlocks[0] as { text: string }).text;
    expect(finalText).toContain(fixture.summary.finalResultText.slice(0, 20));
  });

  test("replay full event timeline follows correct lifecycle ordering", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);
    const allEventTypes = perMessage.flatMap(({ events }) => events.map((e) => e.type));

    // Exactly one agent_start, one agent_end
    expect(allEventTypes.filter((t) => t === "agent_start")).toHaveLength(1);
    expect(allEventTypes.filter((t) => t === "agent_end")).toHaveLength(1);

    // Two turn_start / turn_end pairs (one intermediate boundary + one final)
    expect(allEventTypes.filter((t) => t === "turn_start")).toHaveLength(2);
    expect(allEventTypes.filter((t) => t === "turn_end")).toHaveLength(2);

    // Two message_start / message_end pairs
    expect(allEventTypes.filter((t) => t === "message_start")).toHaveLength(2);
    expect(allEventTypes.filter((t) => t === "message_end")).toHaveLength(2);

    // agent_start is the very first event
    expect(allEventTypes[0]).toBe("agent_start");
    // agent_end is the very last event
    expect(allEventTypes.at(-1)).toBe("agent_end");

    // Each turn_start is followed eventually by a turn_end before the next turn_start
    let turnDepth = 0;
    for (const t of allEventTypes) {
      if (t === "turn_start") {
        turnDepth += 1;
        expect(turnDepth).toBe(1);
      }
      if (t === "turn_end") {
        expect(turnDepth).toBe(1);
        turnDepth -= 1;
      }
    }
    expect(turnDepth).toBe(0);

    // Every tool_execution_start has a matching tool_execution_end
    const toolStarts = allEventTypes
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t === "tool_execution_start");
    const toolEnds = allEventTypes
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t === "tool_execution_end");
    expect(toolStarts).toHaveLength(toolEnds.length);
  });

  test("persistence-triggering events (turn_end) fire before agent_end for multi-turn traces", async () => {
    const fixture = await loadFixture();
    const perMessage = replayFixture(fixture);
    const allEvents = perMessage.flatMap(({ events }) => events);

    // Collect indices of persistence-triggering events
    const persistIndices = allEvents
      .map((e, i) => ({ type: e.type, i }))
      .filter(({ type }) => type === "turn_end" || type === "agent_end");

    // Should have 3 persistence triggers: turn_end (intermediate), turn_end (final), agent_end
    expect(persistIndices.map(({ type }) => type)).toEqual([
      "turn_end",   // intermediate boundary — triggers mid-loop persistence
      "turn_end",   // final turn end
      "agent_end",  // loop complete
    ]);

    // The intermediate turn_end comes before agent_end
    expect(persistIndices[0].i).toBeLessThan(persistIndices[2].i);
  });
});
