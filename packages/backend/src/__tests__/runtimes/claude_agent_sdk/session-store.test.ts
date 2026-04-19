import { describe, expect, test, beforeEach } from "bun:test";
import { toSessionStoreEntries, createSessionStore } from "../../../runtimes/claude_agent_sdk/session-store.js";
import type { AgentRuntimeMessage } from "../../../runtimes/registry.js";
import { useTestDb } from "../../helpers/test-db.js";
import { createProject } from "../../../project-store.js";
import { createSession, persistMessages } from "../../../session-store.js";

function msg(partial: Record<string, unknown>): AgentRuntimeMessage {
  return partial as AgentRuntimeMessage;
}

describe("toSessionStoreEntries", () => {
  test("simple user message", () => {
    const result = toSessionStoreEntries([
      msg({ role: "user", content: [{ type: "text", text: "hello" }] }),
    ]);

    expect(result).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
  });

  test("simple assistant message with text only and end_turn", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        stopReason: "endTurn",
      }),
    ]);

    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          stop_reason: "end_turn",
        },
      },
    ]);
  });

  test("assistant with builtin tool call — denormalizes tool name and args", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that." },
          {
            type: "toolCall",
            id: "tc1",
            name: "edit",
            arguments: { path: "/foo/bar.ts", oldText: "abc", newText: "xyz" },
          },
        ],
        stopReason: "toolUse",
      }),
    ]);

    expect(result).toEqual([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that." },
            {
              type: "tool_use",
              id: "tc1",
              name: "Edit",
              input: { file_path: "/foo/bar.ts", old_string: "abc", new_string: "xyz" },
            },
          ],
          stop_reason: "tool_use",
        },
      },
    ]);
  });

  test("assistant with custom tool call — adds mcp prefix", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc2",
            name: "create_task",
            arguments: { title: "Do stuff", description: "details" },
          },
        ],
        stopReason: "toolUse",
      }),
    ]);

    expect(result[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tc2",
            name: "mcp__custom-tools__create_task",
            input: { title: "Do stuff", description: "details" },
          },
        ],
        stop_reason: "tool_use",
      },
    });
  });

  test("single tool result", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      }),
    ]);

    expect(result).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc1",
              content: "file contents",
              is_error: false,
            },
          ],
        },
      },
    ]);
  });

  test("multiple consecutive tool results merged into one user entry", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "result 1" }],
        isError: false,
      }),
      msg({
        role: "toolResult",
        toolCallId: "tc2",
        content: [{ type: "text", text: "result 2" }],
        isError: false,
      }),
      msg({
        role: "toolResult",
        toolCallId: "tc3",
        content: [{ type: "text", text: "error!" }],
        isError: true,
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc1", content: "result 1", is_error: false },
          { type: "tool_result", tool_use_id: "tc2", content: "result 2", is_error: false },
          { type: "tool_result", tool_use_id: "tc3", content: "error!", is_error: true },
        ],
      },
    });
  });

  test("compaction summary uses summary field", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "compactionSummary",
        summary: "This is the summary.",
        content: "This is the content.",
      }),
    ]);

    expect(result).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: "This is the summary.",
        },
      },
    ]);
  });

  test("compaction summary falls back to content string", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "compactionSummary",
        content: "Fallback content.",
      }),
    ]);

    expect(result).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: "Fallback content.",
        },
      },
    ]);
  });

  test("full conversation round-trip", () => {
    const result = toSessionStoreEntries([
      msg({ role: "user", content: [{ type: "text", text: "Read /foo" }] }),
      msg({
        role: "assistant",
        content: [
          { type: "text", text: "Reading..." },
          {
            type: "toolCall",
            id: "tc1",
            name: "read",
            arguments: { path: "/foo" },
          },
        ],
        stopReason: "toolUse",
      }),
      msg({
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "contents of /foo" }],
        isError: false,
      }),
      msg({
        role: "assistant",
        content: [{ type: "text", text: "Here are the contents." }],
        stopReason: "endTurn",
      }),
    ]);

    expect(result).toHaveLength(4);

    // User message
    expect(result[0]).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Read /foo" }] },
    });

    // Assistant with tool call
    expect(result[1]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading..." },
          { type: "tool_use", id: "tc1", name: "Read", input: { file_path: "/foo" } },
        ],
        stop_reason: "tool_use",
      },
    });

    // Tool result
    expect(result[2]).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc1", content: "contents of /foo", is_error: false },
        ],
      },
    });

    // Final assistant
    expect(result[3]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here are the contents." }],
        stop_reason: "end_turn",
      },
    });
  });

  test("assistant with thinking blocks preserved", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here's my answer." },
        ],
        stopReason: "endTurn",
      }),
    ]);

    expect(result[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here's my answer." },
        ],
        stop_reason: "end_turn",
      },
    });
  });

  test("unknown roles are skipped", () => {
    const result = toSessionStoreEntries([
      msg({ role: "user", content: [{ type: "text", text: "hi" }] }),
      msg({ role: "system", content: "something" }),
      msg({ role: "unknown_role", content: [] }),
      msg({ role: "assistant", content: [{ type: "text", text: "bye" }], stopReason: "endTurn" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("assistant");
  });

  test("read tool denormalizes path arg", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "read",
            arguments: { path: "/some/file.ts", offset: 10 },
          },
        ],
        stopReason: "toolUse",
      }),
    ]);

    expect(result[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tc1",
            name: "Read",
            input: { file_path: "/some/file.ts", offset: 10 },
          },
        ],
        stop_reason: "tool_use",
      },
    });
  });

  test("tool result with multiple content blocks preserves array", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "toolResult",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "part 1" },
          { type: "text", text: "part 2" },
        ],
        isError: false,
      }),
    ]);

    expect(result[0]).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tc1",
            content: [
              { type: "text", text: "part 1" },
              { type: "text", text: "part 2" },
            ],
            is_error: false,
          },
        ],
      },
    });
  });

  test("unknown tool names pass through as-is", () => {
    const result = toSessionStoreEntries([
      msg({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "some_custom_mcp_tool",
            arguments: { key: "value" },
          },
        ],
        stopReason: "toolUse",
      }),
    ]);

    expect(result[0]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tc1",
            name: "some_custom_mcp_tool",
            input: { key: "value" },
          },
        ],
        stop_reason: "tool_use",
      },
    });
  });
});

describe("createSessionStore", () => {
  useTestDb();

  let projectId: number;

  beforeEach(() => {
    const project = createProject("Test Project", "/tmp/test-project");
    projectId = project.id;
  });

  test("load() returns null when no messages exist", async () => {
    const store = createSessionStore();
    createSession("sess-empty", projectId, { agentRuntimeType: "claude_agent_sdk" });

    const result = await store.load({ projectKey: "test", sessionId: "sess-empty" });
    expect(result).toBeNull();
  });

  test("load() returns translated entries when messages exist", async () => {
    const store = createSessionStore();
    createSession("sess-1", projectId, { agentRuntimeType: "claude_agent_sdk" });
    persistMessages("sess-1", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "endTurn" },
    ]);

    const result = await store.load({ projectKey: "test", sessionId: "sess-1" });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(result![1]).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
    });
  });

  test("append() is a no-op", async () => {
    const store = createSessionStore();
    await store.append(
      { projectKey: "test", sessionId: "sess-1" },
      [{ type: "user", message: { role: "user", content: "test" } }],
    );
  });

  test("listSubkeys() returns empty array", async () => {
    const store = createSessionStore();
    const result = await store.listSubkeys!({ projectKey: "test", sessionId: "sess-1" });
    expect(result).toEqual([]);
  });
});
