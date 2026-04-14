import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  COMPACTION_NOTICE,
  normalizeClaudeToolName,
  transformClaudeSessionMessages,
} from "../../../runtimes/claude_agent_sdk/events.js";

/**
 * Build a partial SessionMessage for testing. The session message
 * transformer only reads type/message/subtype — required metadata like
 * uuid/session_id/parent_tool_use_id is unused and safely omitted.
 */
function sessionMsg(partial: Record<string, unknown>): SessionMessage {
  return partial as SessionMessage;
}

describe("claude sdk event helpers", () => {
  test("normalizes mcp-prefixed and builtin tool names", () => {
    expect(normalizeClaudeToolName("mcp__custom-tools__create_task")).toBe("create_task");
    expect(normalizeClaudeToolName("Read")).toBe("read");
    expect(normalizeClaudeToolName("Bash")).toBe("bash");
    expect(normalizeClaudeToolName("custom_tool")).toBe("custom_tool");
  });

  test("normalizes args in session message transform", () => {
    const transformed = transformClaudeSessionMessages([
      sessionMsg({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "tc1",
            name: "Read",
            input: { file_path: "/foo/bar.ts", offset: 10 },
          }],
          stop_reason: "tool_use",
        },
      }),
    ]);

    const content = transformed[0].content;
    const toolCall = Array.isArray(content) ? content[0] as Record<string, unknown> : null;
    expect((toolCall as Record<string, unknown>)?.arguments).toEqual({ path: "/foo/bar.ts", offset: 10 });
    expect(((toolCall as Record<string, unknown>)?.arguments as Record<string, unknown>)?.file_path).toBeUndefined();
  });

  test("session message transform skips blank user wrappers for tool_result-only messages", () => {
    const transformed = transformClaudeSessionMessages([
      sessionMsg({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "tc1",
            name: "Bash",
            input: { command: "ls" },
          }],
          stop_reason: "tool_use",
        },
      }),
      sessionMsg({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tc1",
            content: [{ type: "text", text: "file1\nfile2" }],
          }],
        },
      }),
      sessionMsg({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Done" }],
          stop_reason: "end_turn",
        },
      }),
    ]);

    expect(transformed.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(transformed[1]).toEqual(expect.objectContaining({
      role: "toolResult",
      toolCallId: "tc1",
    }));
  });

  test("session message transform detects sdk compaction string wrapper as compactionSummary", () => {
    const transformed = transformClaudeSessionMessages([
      sessionMsg({
        type: "user",
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation.",
        },
      }),
      sessionMsg({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Continuing." }],
          stop_reason: "end_turn",
        },
      }),
      sessionMsg({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "What was my last message?" }],
        },
      }),
    ]);

    expect(transformed[0]).toEqual(expect.objectContaining({
      role: "compactionSummary",
      summary: COMPACTION_NOTICE,
      content: COMPACTION_NOTICE,
    }));
    expect(typeof transformed[0]?.content).toBe("string");
    expect(transformed.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
    ]);
  });

  test("session message transform keeps compact boundary content as a string", () => {
    const transformed = transformClaudeSessionMessages([
      sessionMsg({
        type: "system",
        subtype: "compact_boundary",
      }),
    ]);

    expect(transformed).toEqual([
      expect.objectContaining({
        role: "compactionSummary",
        summary: COMPACTION_NOTICE,
        content: COMPACTION_NOTICE,
      }),
    ]);
    expect(typeof transformed[0]?.content).toBe("string");
  });
});
