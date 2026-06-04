import { describe, expect, test, beforeEach } from "bun:test";
import { toSessionStoreEntries, createSessionStore, type SessionEntryContext } from "../../../runtimes/claude_agent_sdk/session-store.js";
import type { RuntimeMessage } from "../../../messages-store.js";
import { useTestDb } from "../../helpers/test-db.js";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../../session-store.js";
import { loadMessages, persistMessages } from "../../../messages-store.js";

function msg(partial: Partial<RuntimeMessage>): RuntimeMessage {
  // eslint-disable-next-line typescript-eslint/consistent-type-assertions -- test helper intentionally casts partials
  return partial as RuntimeMessage;
}

type StrippedEntry<T extends Record<string, unknown>> = Omit<T, "uuid" | "parentUuid" | "sessionId" | "cwd" | "timestamp">;

/** Strip generated metadata fields from entries so existing assertions stay clean. */
function stripMeta<T extends Record<string, unknown>>(
  entry: T,
): StrippedEntry<T> {
  const { uuid: _uuid, parentUuid: _parentUuid, sessionId: _sessionId, cwd: _cwd, timestamp: _timestamp, ...rest } = entry;
  if ("message" in rest && rest.message && typeof rest.message === "object") {
    const msgObj = Object.entries(rest.message).reduce<Record<string, unknown>>((acc, [k, v]) => {
      if (k !== "id") acc[k] = v;
      return acc;
    }, {});
    // @ts-expect-error -- overwriting message field on rest for test assertion
    rest.message = msgObj;
  }
  // eslint-disable-next-line typescript-eslint/consistent-type-assertions -- generic rest spread loses exact type
  return rest as StrippedEntry<T>;
}

/** Assert that entries form a valid uuid/parentUuid chain with unique IDs. */
function expectUuidChain(entries: { uuid?: string; parentUuid?: string }[]) {
  expect(entries[0].uuid).toEqual(expect.any(String));
  expect(entries[0].parentUuid).toBeUndefined();
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i].uuid).toEqual(expect.any(String));
    expect(entries[i].parentUuid).toBe(entries[i - 1].uuid);
  }
  const uuids = entries.map((e) => e.uuid);
  expect(new Set(uuids).size).toBe(uuids.length);
}

const testContext: SessionEntryContext = { sessionId: "test-session", cwd: "/tmp/test" };

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
    expectUuidChain(result);
  });

  test("user image blocks are translated to SDK image content", () => {
    const result = toSessionStoreEntries(
      [
        msg({
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image", data: "base64-image", mimeType: "image/png", filename: "image.png" },
          ],
        }),
      ],
      testContext,
    );

    expect(stripMeta(result[0])).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "base64-image",
            },
          },
        ],
      },
    });
    expectUuidChain(result);
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
    expectUuidChain(result);
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

    expect(stripMeta(result[0])).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Read /foo" }] },
    });

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

    expect(stripMeta(result[2])).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc1", content: "contents of /foo", is_error: false },
        ],
      },
    });

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

    expect(result).toHaveLength(5);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("assistant");
    expect(result[2].type).toBe("assistant");
    expect(result[3].type).toBe("user"); // tool result
    expect(result[4].type).toBe("assistant");

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
        msg({ role: "system", content: [{ type: "text", text: "something" }] }),
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

    expectUuidChain(result);
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
    createSession("sess-empty", projectId, { agentRuntimeType: "claude_agent_sdk" });
    const store = createSessionStore("sess-empty", "/tmp/test-project");

    const result = await store.load({ projectKey: "test", sessionId: "sess-empty" });
    expect(result).toBeNull();
  });

  test("load() returns translated entries when messages exist", async () => {
    createSession("sess-1", projectId, { agentRuntimeType: "claude_agent_sdk" });
    const store = createSessionStore("sess-1", "/tmp/test-project");
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
    expectUuidChain(result!);
    // Verify metadata
    expect(result![0].sessionId).toBe("sess-1");
    expect(result![0].cwd).toBe("/tmp/test-project");
    expect(result![0].timestamp).toEqual(expect.any(String));
  });

  test("append() writes message entries to SQLite", async () => {
    createSession("sess-append", projectId, { agentRuntimeType: "claude_agent_sdk" });
    const store = createSessionStore("sess-append", "/tmp/test-project");

    await store.append(
      { projectKey: "test", sessionId: "sess-append" },
      [
        {
          type: "user",
          uuid: "u1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
        {
          type: "assistant",
          uuid: "a1",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi there" }],
            stop_reason: "end_turn",
          },
        },
      ],
    );

    const messages = loadMessages("sess-append");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toEqual([{ type: "text", text: "hi there" }]);
  });

  test("append() ignores non-message entry types", async () => {
    createSession("sess-filter", projectId, { agentRuntimeType: "claude_agent_sdk" });
    const store = createSessionStore("sess-filter", "/tmp/test-project");

    await store.append(
      { projectKey: "test", sessionId: "sess-filter" },
      [
        { type: "ai-title", uuid: "t1", timestamp: new Date().toISOString(), title: "Hello" },
        { type: "queue-operation", uuid: "q1", timestamp: new Date().toISOString() },
        { type: "last-prompt", uuid: "lp1", timestamp: new Date().toISOString() },
        {
          type: "user",
          uuid: "u1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
      ],
    );

    const messages = loadMessages("sess-filter");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  test("append() ignores entries with subpath", async () => {
    createSession("sess-sub", projectId, { agentRuntimeType: "claude_agent_sdk" });
    const store = createSessionStore("sess-sub", "/tmp/test-project");

    await store.append(
      { projectKey: "test", sessionId: "sess-sub", subpath: "subagents/agent-123" },
      [
        {
          type: "user",
          uuid: "u1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text: "subagent msg" }] },
        },
      ],
    );

    const messages = loadMessages("sess-sub");
    expect(messages).toHaveLength(0);
  });

  test("listSubkeys() returns empty array", async () => {
    const store = createSessionStore("sess-1", "/tmp/test-project");
    const result = await store.listSubkeys!({ projectKey: "test", sessionId: "sess-1" });
    expect(result).toEqual([]);
  });
});
