import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../../session-store.js";
import { attachStoredMessageMetadata, loadMessagePage, persistMessages } from "../../../messages-store.js";
import { createTestAgentSession } from "../../helpers/test-pi.js";
import { useTestDb } from "../../helpers/test-db.js";
import { createServerState } from "../../helpers/server-state.js";
import { getPiSession } from "../../../runtimes/pi/runtime.js";
import { createHydratedSessionManager, ephemeralPrompt, hydrateSessionManager, PiRuntimeAdapter, toPiThinkingLevel } from "../../../runtimes/pi/session.js";
import type { SessionEntry, SessionMessageEntry, CompactionEntry } from "@earendil-works/pi-coding-agent";

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

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

describe("PiRuntimeAdapter", () => {
  useTestDb();

  test("preserves stored metadata across Pi resume without hydrating it into native messages", async () => {
    const project = createProject("Resume", "/tmp");
    createSession("sess-pi-metadata", project.id, { agentRuntimeType: "pi" });
    const messages = [{ role: "user" as const, content: textContent("hello"), timestamp: 1000, logicalId: "pi-user-1" }];
    persistMessages("sess-pi-metadata", messages);
    const id = loadMessagePage("sess-pi-metadata", 10).items[0].id;
    attachStoredMessageMetadata("sess-pi-metadata", id, "audit", { reviewed: true });

    const runtime = await new PiRuntimeAdapter().createRuntime({
      state: createServerState(), projectId: project.id, projectDir: "/tmp",
      sessionId: "sess-pi-metadata", task: null, resume: true,
      sessionTools: { builtins: [], customTools: [] },
    });
    try {
      expect(getPiSession(runtime).messages).toEqual([
        { role: "user", content: textContent("hello"), timestamp: 1000 },
      ]);
      expect(getPiSession(runtime).sessionManager.getEntries()[0].id).toBe("pi-user-1");
      const snapshot = await runtime.getMessages();
      expect(snapshot).toEqual(messages);
      persistMessages("sess-pi-metadata", snapshot);
      expect(loadMessagePage("sess-pi-metadata", 10).items[0]).toEqual({
        id, parentId: null, message: { ...messages[0], metadata: { audit: { reviewed: true } } },
      });
    } finally {
      await runtime.close();
    }
  });

  test("maps Reins max thinking to Pi's native max level", () => {
    expect(toPiThinkingLevel("max")).toBe("max");
  });

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

describe("Pi stable message identity", () => {
  test("assigns native IDs to legacy messages and exposes them without putting them in model messages", async () => {
    const sm = createHydratedSessionManager([
      { role: "user", content: textContent("legacy"), timestamp: 1000 },
    ], "/tmp", "legacy-session");
    const session = await createTestAgentSession({ sessionManager: sm });
    session.agent.state.messages = sm.buildSessionContext().messages;
    const runtime = new (await import("../../../runtimes/pi/runtime.js")).PiAgentRuntime(session, "legacy-session");

    expect(session.messages[0]).not.toHaveProperty("logicalId");
    expect((await runtime.getMessages())[0].logicalId).toBe(sm.getEntries()[0].id);
  });

  test("maps duplicate timestamps and retry replacements by active message object", async () => {
    const sm = createHydratedSessionManager([
      { role: "assistant", content: textContent("failed"), timestamp: 1000, logicalId: "failed-id" },
      { role: "assistant", content: textContent("replacement"), timestamp: 1000, logicalId: "replacement-id" },
    ]);
    const session = await createTestAgentSession({ sessionManager: sm });
    const replacement = sm.buildSessionContext().messages[1];
    session.agent.state.messages = [replacement];
    const runtime = new (await import("../../../runtimes/pi/runtime.js")).PiAgentRuntime(session, "retry");

    expect(await runtime.getMessages()).toEqual([
      { role: "assistant", content: textContent("replacement"), timestamp: 1000, logicalId: "replacement-id" },
    ]);
  });

  test("retains compaction summary and retained-tail identities", async () => {
    const sm = createHydratedSessionManager([
      { role: "compactionSummary", summary: "summary", timestamp: 1000, logicalId: "summary-id" },
      { role: "assistant", content: textContent("retained"), timestamp: 1000, logicalId: "retained-id" },
    ]);
    const session = await createTestAgentSession({ sessionManager: sm });
    session.agent.state.messages = sm.buildSessionContext().messages;
    const runtime = new (await import("../../../runtimes/pi/runtime.js")).PiAgentRuntime(session, "compact");

    expect((await runtime.getMessages()).map((message) => message.logicalId)).toEqual([
      "summary-id", "retained-id",
    ]);
  });
});

describe("hydrateSessionManager", () => {
  test("populates entries from regular messages", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "user", content: textContent("hello") },
      { role: "assistant", content: textContent("hi there") },
      { role: "user", content: textContent("what is 2+2?") },
      { role: "assistant", content: textContent("4") },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.type === "message")).toBe(true);
    const msg0 = asMessage(entries[0]).message;
    expect(msg0.role).toBe("user");
    if ("content" in msg0) expect(msg0.content).toEqual(textContent("hello"));
    else throw new Error("expected content on user message");
    const msg3 = asMessage(entries[3]).message;
    expect(msg3.role).toBe("assistant");
    if ("content" in msg3) expect(msg3.content).toEqual(textContent("4"));
    else throw new Error("expected content on assistant message");
  });

  test("entries form a linear chain via parentId", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "user", content: textContent("a") },
      { role: "assistant", content: textContent("b") },
      { role: "user", content: textContent("c") },
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
      { role: "user", content: textContent("hello") },
      { role: "assistant", content: textContent("hi") },
      { role: "user", content: textContent("bye") },
    ];

    hydrateSessionManager(sm, messages);

    const branch = sm.getBranch();
    expect(branch).toHaveLength(3);
  });

  test("handles compactionSummary as compaction entry", () => {
    const sm = SessionManager.inMemory();
    const messages = [
      { role: "compactionSummary", summary: "discussed project setup" },
      { role: "user", content: textContent("what next?") },
      { role: "assistant", content: textContent("let's continue") },
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
      { role: "user", content: textContent("new question") },
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
      { role: "user", content: textContent("hello") },
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
      { role: "user", content: textContent("list files") },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll run ls" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "file1.ts\nfile2.ts" }] },
      { role: "assistant", content: textContent("Here are the files") },
    ];

    hydrateSessionManager(sm, messages);

    const entries = sm.getEntries();
    expect(entries).toHaveLength(4);
    expect(asMessage(entries[2]).message.role).toBe("toolResult");
  });
});
