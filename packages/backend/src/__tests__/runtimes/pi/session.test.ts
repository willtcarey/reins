import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineTool, SessionManager } from "@mariozechner/pi-coding-agent";
import { createTestAgentSession } from "../../helpers/test-pi.js";
import { useTestDb } from "../../helpers/test-db.js";
import { createServerState } from "../../helpers/server-state.js";
import { getPiSession } from "../../../runtimes/pi/runtime.js";
import { ephemeralPrompt, hydrateSessionManager, PiRuntimeAdapter } from "../../../runtimes/pi/session.js";
import type { SessionEntry, SessionMessageEntry, CompactionEntry } from "@mariozechner/pi-coding-agent";

/** Narrow a SessionEntry to SessionMessageEntry (throws if wrong type). */
function asMessage(entry: SessionEntry): SessionMessageEntry {
  if (entry.type !== "message") throw new Error(`Expected message entry, got ${entry.type}`);
  return entry;
}

/** Narrow a SessionEntry to CompactionEntry (throws if wrong type). */
function asCompaction(entry: SessionEntry): CompactionEntry {
  if (entry.type !== "compaction") throw new Error(`Expected compaction entry, got ${entry.type}`);
  return entry;
}

describe("PiRuntimeAdapter", () => {
  useTestDb();

  test("enables custom tools in the pi SDK allowlist", async () => {
    const customTool = defineTool({
      name: "create_task",
      label: "Create Task",
      description: "Create a task",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    });

    const adapter = new PiRuntimeAdapter();
    const runtime = await adapter.createRuntime({
      state: createServerState(),
      projectId: 1,
      projectDir: "/tmp",
      sessionId: "sess-pi-custom-tools",
      task: null,
      sessionTools: {
        builtins: ["read", "write", "edit", "bash"],
        customTools: [customTool],
      },
    });

    try {
      const session = getPiSession(runtime);
      const allToolNames = session.getAllTools().map((tool) => tool.name);

      expect(allToolNames).toContain("create_task");
      expect(session.getActiveToolNames()).toContain("create_task");
    } finally {
      await runtime.close();
    }
  });
});

describe("ephemeralPrompt", () => {
  test("aborts and returns empty string when prompt times out", async () => {
    const session = await createTestAgentSession();

    let releasePrompt: (() => void) | undefined;
    const prompt = mock(async (_text: string, _options?: { expandPromptTemplates?: boolean }) => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const abort = mock(async () => {
      releasePrompt?.();
    });

    session.prompt = prompt;
    session.abort = abort;

    const result = await ephemeralPrompt(session, { prompt: "hello", timeoutMs: 1 });

    expect(result).toBe("");
    expect(prompt).toHaveBeenCalledWith("hello", { expandPromptTemplates: false });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("returns trimmed assistant text when prompt completes before timeout", async () => {
    const session = await createTestAgentSession();

    const prompt = mock(async (_text: string, _options?: { expandPromptTemplates?: boolean }) => {});
    const abort = mock(async () => {});

    session.prompt = prompt;
    session.abort = abort;
    session.getLastAssistantText = () => "  done  ";

    const result = await ephemeralPrompt(session, { prompt: "hello", timeoutMs: 1000 });

    expect(result).toBe("done");
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("hydrateSessionManager", () => {
  test("populates entries from regular messages", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what is 2+2?" },
      { role: "assistant", content: "4" },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.type === "message")).toBe(true);
    const msg0 = asMessage(entries[0]).message;
    expect(msg0.role).toBe("user");
    if ("content" in msg0) expect(msg0.content).toBe("hello");
    else throw new Error("expected content on user message");
    const msg3 = asMessage(entries[3]).message;
    expect(msg3.role).toBe("assistant");
    if ("content" in msg3) expect(msg3.content).toBe("4");
    else throw new Error("expected content on assistant message");
  });

  test("entries form a linear chain via parentId", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries[0].parentId).toBeNull();
    expect(entries[1].parentId).toBe(entries[0].id);
    expect(entries[2].parentId).toBe(entries[1].id);
  });

  test("getBranch returns all entries after hydration", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ];

    hydrateSessionManager(sm, messages);

    const branch = sm.getBranch();
    expect(branch).toHaveLength(3);
  });

  test("handles compactionSummary as compaction entry", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "compactionSummary", summary: "discussed project setup" },
      { role: "user", content: "what next?" },
      { role: "assistant", content: "let's continue" },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("compaction");
    expect(asCompaction(entries[0]).summary).toBe("discussed project setup");
    expect(entries[1].type).toBe("message");
    expect(entries[2].type).toBe("message");
  });

  test("compaction entry is visible in getBranch", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "compactionSummary", summary: "old context" },
      { role: "user", content: "new question" },
    ];

    hydrateSessionManager(sm, messages);

    const branch = sm.getBranch();
    expect(branch).toHaveLength(2);
    expect(branch[0].type).toBe("compaction");
    expect(branch[1].type).toBe("message");
  });

  test("handles empty message array", () => {
    const sm = SessionManager.inMemory();

    hydrateSessionManager(sm, []);

    expect(sm.getEntries()).toHaveLength(0);
    expect(sm.getBranch()).toHaveLength(0);
  });

  test("handles compactionSummary with missing summary field", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "compactionSummary" },
      { role: "user", content: "hello" },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("compaction");
    expect(asCompaction(entries[0]).summary).toBe("");
  });

  test("handles toolResult messages", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll run ls" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "file1.ts\nfile2.ts" }] },
      { role: "assistant", content: "Here are the files" },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries).toHaveLength(4);
    expect(asMessage(entries[2]).message.role).toBe("toolResult");
  });
});
