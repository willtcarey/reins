import { describe, expect, test, beforeEach } from "bun:test";
import { toSessionStoreEntries, createSessionStore } from "../../../runtimes/claude_agent_sdk/session-store.js";
import type { AgentRuntimeMessage } from "../../../runtimes/registry.js";
import { useTestDb } from "../../helpers/test-db.js";
import { createProject } from "../../../project-store.js";
import { createSession, persistMessages } from "../../../session-store.js";

function msg(partial: Record<string, unknown>): AgentRuntimeMessage {
  return partial as AgentRuntimeMessage;
}

/** Strip generated metadata fields from entries so existing assertions stay clean. */
function stripMeta<T extends Record<string, unknown>>(
  entry: T,
): Omit<T, "uuid" | "parentUuid" | "sessionId" | "cwd" | "timestamp"> {
  const { uuid: _uuid, parentUuid: _parentUuid, sessionId: _sessionId, cwd: _cwd, timestamp: _timestamp, ...rest } = entry;
  // Also strip the generated message.id
  if (rest.message && typeof rest.message === "object") {
    const { id: _id, ...msgRest } = rest.message as Record<string, unknown>;
    rest.message = msgRest;
  }
  return rest as Omit<T, "uuid" | "parentUuid" | "sessionId" | "cwd" | "timestamp">;
}

const testContext = { sessionId: "test-session", cwd: "/tmp/test" };

describe("toSessionStoreEntries", () => {
  test("simple user message", () => {
    const result = toSessionStoreEntries(
      [msg({ role: "user", content: [{ type: "text", text: "hello" }] })],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(result[0].uuid).toEqual(expect.any(String));
    expect(result[0].parentUuid).toBeUndefined();
  });

  test("entries include sessionId, cwd, and timestamp metadata", () => {
    const result = toSessionStoreEntries(
      [msg({ role: "user", content: [{ type: "text", text: "hello" }] })],
      testContext,
    );

    expect(result[0].sessionId).toBe("test-session");
    expect(result[0].cwd).toBe("/tmp/test");
    expect(result[0].timestamp).toEqual(expect.any(String));
    // timestamp should be a valid ISO string
    const ts = result[0].timestamp ?? "";
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  test("simple assistant message with text only and end_turn", () => {
    const result = toSessionStoreEntries(
      [
        msg({
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
      },
    });
    expect(result[0].uuid).toEqual(expect.any(String));
    expect(result[0].parentUuid).toBeUndefined();
  });

  test("assistant with builtin tool call — translates tool name and args", () => {
    const result = toSessionStoreEntries(
      [
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
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
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
    });
  });

  test("assistant with custom tool call — adds mcp prefix", () => {
    const result = toSessionStoreEntries(
      [
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
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
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
    const result = toSessionStoreEntries(
      [
        msg({
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
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
    });
  });

  test("multiple consecutive tool results merged into one user entry", () => {
    const result = toSessionStoreEntries(
      [
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
      ],
      testContext,
    );

    expect(result).toHaveLength(1);
    expect(stripMeta(result[0])).toEqual({
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
    const result = toSessionStoreEntries(
      [
        msg({
          role: "compactionSummary",
          summary: "This is the summary.",
          content: "This is the content.",
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "This is the summary.",
      },
    });
  });

  test("compaction summary falls back to content string", () => {
    const result = toSessionStoreEntries(
      [
        msg({
          role: "compactionSummary",
          content: "Fallback content.",
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "Fallback content.",
      },
    });
  });

  test("full conversation round-trip", () => {
    const result = toSessionStoreEntries(
      [
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
      ],
      testContext,
    );

    expect(result).toHaveLength(4);

    // User message
    expect(stripMeta(result[0])).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Read /foo" }] },
    });

    // Assistant with tool call
    expect(stripMeta(result[1])).toEqual({
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
    expect(stripMeta(result[2])).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc1", content: "contents of /foo", is_error: false },
        ],
      },
    });

    // Final assistant
    expect(stripMeta(result[3])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here are the contents." }],
        stop_reason: "end_turn",
      },
    });
  });

  test("thinking blocks with thinkingSignature are kept and mapped to signature", () => {
    const result = toSessionStoreEntries(
      [
        msg({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this...", thinkingSignature: "sig_abc123" },
            { type: "text", text: "Here's my answer." },
          ],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this...", signature: "sig_abc123" },
          { type: "text", text: "Here's my answer." },
        ],
        stop_reason: "end_turn",
      },
    });
  });

  test("thinking blocks without signature are stripped", () => {
    const result = toSessionStoreEntries(
      [
        msg({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "unsigned thinking" },
            { type: "text", text: "Here's my answer." },
          ],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here's my answer." },
        ],
        stop_reason: "end_turn",
      },
    });
  });

  test("assistant entry dropped when all content is unsigned thinking", () => {
    const result = toSessionStoreEntries(
      [
        msg({ role: "user", content: [{ type: "text", text: "hello" }] }),
        msg({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "unsigned thinking only" },
          ],
        }),
        msg({
          role: "assistant",
          content: [
            { type: "text", text: "real response" },
          ],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("assistant");
    expect(stripMeta(result[1])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "real response" }],
        stop_reason: "end_turn",
      },
    });
  });

  test("consecutive assistant messages become separate entries (SDK expects split thinking + tool_use)", () => {
    const result = toSessionStoreEntries(
      [
        msg({
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me read that file...", thinkingSignature: "sig_read" }],
        }),
        msg({
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/foo" } },
          ],
          stopReason: "toolUse",
        }),
      ],
      testContext,
    );

    expect(result).toHaveLength(2);
    expect(stripMeta(result[0])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me read that file...", signature: "sig_read" },
        ],
        stop_reason: undefined,
      },
    });
    expect(stripMeta(result[1])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc1", name: "Read", input: { file_path: "/foo" } },
        ],
        stop_reason: "tool_use",
      },
    });
  });

  test("split assistant messages produce correct entry count: user → assistant(thinking) → assistant(tool_call) → toolResult → assistant(text) = 5 entries", () => {
    const result = toSessionStoreEntries(
      [
        msg({ role: "user", content: [{ type: "text", text: "Read /foo" }] }),
        msg({
          role: "assistant",
          content: [{ type: "thinking", thinking: "I should read the file.", thinkingSignature: "sig_think" }],
        }),
        msg({
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/foo" } },
          ],
          stopReason: "toolUse",
        }),
        msg({
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        }),
        msg({
          role: "assistant",
          content: [{ type: "text", text: "Here are the contents." }],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    // 5 entries: user, assistant(thinking), assistant(tool_use), tool result, final assistant
    expect(result).toHaveLength(5);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("assistant");
    expect(result[2].type).toBe("assistant");
    expect(result[3].type).toBe("user"); // tool result
    expect(result[4].type).toBe("assistant");

    // Thinking and tool_use are separate entries (not merged)
    expect(stripMeta(result[1])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read the file.", signature: "sig_think" },
        ],
        stop_reason: undefined,
      },
    });
    expect(stripMeta(result[2])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc1", name: "Read", input: { file_path: "/foo" } },
        ],
        stop_reason: "tool_use",
      },
    });
  });

  test("unsigned thinking in split assistant messages gets dropped, not the tool_use", () => {
    const result = toSessionStoreEntries(
      [
        msg({ role: "user", content: [{ type: "text", text: "Read /foo" }] }),
        msg({
          role: "assistant",
          content: [{ type: "thinking", thinking: "I should read the file." }],
        }),
        msg({
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/foo" } },
          ],
          stopReason: "toolUse",
        }),
        msg({
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        }),
        msg({
          role: "assistant",
          content: [{ type: "text", text: "Here are the contents." }],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    // 4 entries: user, assistant(tool_use), tool result, final assistant
    // The unsigned thinking assistant entry is dropped entirely
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("assistant");
    expect(result[2].type).toBe("user"); // tool result
    expect(result[3].type).toBe("assistant");

    expect(stripMeta(result[1])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc1", name: "Read", input: { file_path: "/foo" } },
        ],
        stop_reason: "tool_use",
      },
    });
  });

  test("unknown roles are skipped", () => {
    const result = toSessionStoreEntries(
      [
        msg({ role: "user", content: [{ type: "text", text: "hi" }] }),
        msg({ role: "system", content: "something" }),
        msg({ role: "unknown_role", content: [] }),
        msg({ role: "assistant", content: [{ type: "text", text: "bye" }], stopReason: "endTurn" }),
      ],
      testContext,
    );

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("assistant");
  });

  test("read tool translates path arg", () => {
    const result = toSessionStoreEntries(
      [
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
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
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
    const result = toSessionStoreEntries(
      [
        msg({
          role: "toolResult",
          toolCallId: "tc1",
          content: [
            { type: "text", text: "part 1" },
            { type: "text", text: "part 2" },
          ],
          isError: false,
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
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
    const result = toSessionStoreEntries(
      [
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
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
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

  test("entries have uuid/parentUuid chain", () => {
    const result = toSessionStoreEntries(
      [
        msg({ role: "user", content: [{ type: "text", text: "hello" }] }),
        msg({
          role: "assistant",
          content: [
            { type: "text", text: "Reading..." },
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/foo" } },
          ],
          stopReason: "toolUse",
        }),
        msg({
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "contents" }],
          isError: false,
        }),
        msg({
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "endTurn",
        }),
      ],
      testContext,
    );

    expect(result).toHaveLength(4);

    // First entry: uuid present, no parentUuid
    expect(result[0].uuid).toEqual(expect.any(String));
    expect(result[0].parentUuid).toBeUndefined();

    // Each subsequent entry links back to the previous
    for (let i = 1; i < result.length; i++) {
      expect(result[i].uuid).toEqual(expect.any(String));
      expect(result[i].parentUuid).toBe(result[i - 1].uuid);
    }

    // All UUIDs are unique
    const uuids = result.map((e) => e.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
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
    const store = createSessionStore("/tmp/test-project");
    createSession("sess-empty", projectId, { agentRuntimeType: "claude_agent_sdk" });

    const result = await store.load({ projectKey: "test", sessionId: "sess-empty" });
    expect(result).toBeNull();
  });

  test("load() returns translated entries when messages exist", async () => {
    const store = createSessionStore("/tmp/test-project");
    createSession("sess-1", projectId, { agentRuntimeType: "claude_agent_sdk" });
    persistMessages("sess-1", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "endTurn" },
    ]);

    const result = await store.load({ projectKey: "test", sessionId: "sess-1" });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(stripMeta(result![0])).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(stripMeta(result![1])).toEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
    });
    // Verify UUID chain
    expect(result![0].uuid).toEqual(expect.any(String));
    expect(result![0].parentUuid).toBeUndefined();
    expect(result![1].uuid).toEqual(expect.any(String));
    expect(result![1].parentUuid).toBe(result![0].uuid);
    // Verify metadata
    expect(result![0].sessionId).toBe("sess-1");
    expect(result![0].cwd).toBe("/tmp/test-project");
    expect(result![0].timestamp).toEqual(expect.any(String));
  });

  test("append() is a no-op", async () => {
    const store = createSessionStore("/tmp/test-project");
    await store.append(
      { projectKey: "test", sessionId: "sess-1" },
      [{ type: "user", message: { role: "user", content: "test" } }],
    );
  });

  test("listSubkeys() returns empty array", async () => {
    const store = createSessionStore("/tmp/test-project");
    const result = await store.listSubkeys!({ projectKey: "test", sessionId: "sess-1" });
    expect(result).toEqual([]);
  });
});
