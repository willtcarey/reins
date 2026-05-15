import { describe, test, expect, beforeEach } from "bun:test";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionEntry, SessionMessageEntry, CompactionEntry } from "@mariozechner/pi-coding-agent";
import { useTestDb } from "./helpers/test-db.js";

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
import { createProject } from "../project-store.js";
import { createTask } from "../task-store.js";
import {
  createSession,
  getSession,
  listSessions,
  listPaletteItems,
  updateSessionMeta,
  persistMessages,
  loadMessages,
  listSessionEntries,
  loadMessagesForLLM,
} from "../session-store.js";
import { hydrateSessionManager } from "../runtimes/pi/session.js";

let projectId: number;

describe("session-store", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Test Project", "/tmp/test-project");
    projectId = project.id;
  });

  describe("createSession", () => {
    test("returns full row with defaults", () => {
      const s = createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      expect(s.id).toBe("sess-1");
      expect(s.project_id).toBe(projectId);
      expect(s.name).toBeNull();
      expect(s.model_provider).toBeNull();
      expect(s.model_id).toBeNull();
      expect(s.thinking_level).toBe("off");
      expect(s.agent_runtime_type).toBe("pi");
      expect(s.task_id).toBeNull();
      expect(s.parent_session_id).toBeNull();
      expect(s.created_at).toBeString();
      expect(s.updated_at).toBeString();
    });

    test("accepts optional fields", () => {
      // Create parent session first (FK constraint)
      createSession("sess-parent", projectId, { agentRuntimeType: "pi" });
      const s = createSession("sess-2", projectId, {
        modelProvider: "anthropic",
        modelId: "claude-3",
        thinkingLevel: "high",
        agentRuntimeType: "claude_agent_sdk",
        taskId: undefined,
        parentSessionId: "sess-parent",
      });
      expect(s.model_provider).toBe("anthropic");
      expect(s.model_id).toBe("claude-3");
      expect(s.thinking_level).toBe("high");
      expect(s.agent_runtime_type).toBe("claude_agent_sdk");
      expect(s.parent_session_id).toBe("sess-parent");
    });

    test("can be linked to a task", () => {
      const task = createTask(projectId, "T", null, "task/t");
      const s = createSession("sess-t", projectId, {  agentRuntimeType: "pi",taskId: task.id });
      expect(s.task_id).toBe(task.id);
    });
  });

  describe("getSession", () => {
    test("returns the session by id", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const fetched = getSession("sess-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe("sess-1");
    });

    test("returns null for non-existent id", () => {
      expect(getSession("nonexistent")).toBeNull();
    });
  });

  describe("listSessions", () => {
    test("returns project-scoped sessions excluding task sessions", () => {
      createSession("free-1", projectId, { agentRuntimeType: "pi" });
      const task = createTask(projectId, "T", null, "task/t");
      createSession("task-1", projectId, {  agentRuntimeType: "pi",taskId: task.id });

      const list = listSessions({ projectId, taskId: null });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("free-1");
    });

    test("includes message_count and first_message", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: [{ type: "text", text: "Hello world" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ]);

      const list = listSessions({ projectId, taskId: null });
      expect(list).toHaveLength(1);
      expect(list[0].message_count).toBe(2);
      expect(list[0].first_message).toBe("Hello world");
    });

    test("returns full session rows so list and query callers share one shape", () => {
      createSession("sess-full", projectId, {
        agentRuntimeType: "pi",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "medium",
      });
      persistMessages("sess-full", [
        { role: "user", content: [{ type: "text", text: "Full row prompt" }] },
      ]);

      const list = listSessions({ projectId, taskId: null });

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: "sess-full",
        project_id: projectId,
        name: null,
        model_provider: "anthropic",
        model_id: "claude-sonnet-4",
        thinking_level: "medium",
        agent_runtime_type: "pi",
        task_id: null,
        parent_session_id: null,
        message_count: 1,
        first_message: "Full row prompt",
      });
    });

    test("ordered by updated_at DESC", () => {
      createSession("older", projectId, { agentRuntimeType: "pi" });
      createSession("newer", projectId, { agentRuntimeType: "pi" });

      // Touch 'older' to make it more recent
      persistMessages("older", [
        { role: "user", content: [{ type: "text", text: "bump" }] },
      ]);

      const list = listSessions({ projectId, taskId: null });
      expect(list[0].id).toBe("older");
    });

    test("returns empty array when no sessions exist", () => {
      expect(listSessions({ projectId, taskId: null })).toEqual([]);
    });

    test("strips leading <skill> blocks from first_message preview", () => {
      createSession("sess-skill", projectId, { agentRuntimeType: "pi" });
      const expanded =
        `<skill name="dip" location="/path/SKILL.md">body content</skill>\n\n` +
        `<skill name="tmux" location="/other/SKILL.md">more body</skill>\n\n` +
        `/dip start the server`;
      persistMessages("sess-skill", [
        { role: "user", content: [{ type: "text", text: expanded }] },
      ]);

      const list = listSessions({ projectId, taskId: null });
      expect(list).toHaveLength(1);
      expect(list[0].first_message).toBe("/dip start the server");
    });

    test("leaves first_message null when absent", () => {
      createSession("sess-empty", projectId, { agentRuntimeType: "pi" });
      const list = listSessions({ projectId, taskId: null });
      expect(list).toHaveLength(1);
      expect(list[0].first_message).toBeNull();
    });
  });

  describe("listSessions task scope", () => {
    test("returns sessions scoped to a task", () => {
      const task = createTask(projectId, "T", null, "task/t");
      createSession("task-sess-1", projectId, {  agentRuntimeType: "pi",taskId: task.id });
      createSession("task-sess-2", projectId, {  agentRuntimeType: "pi",taskId: task.id });
      createSession("free-sess", projectId, { agentRuntimeType: "pi" });

      const list = listSessions({ taskId: task.id });
      expect(list).toHaveLength(2);
      const ids = list.map((s) => s.id);
      expect(ids).toContain("task-sess-1");
      expect(ids).toContain("task-sess-2");
    });

    test("strips leading <skill> blocks from first_message preview", () => {
      const task = createTask(projectId, "T", null, "task/t");
      createSession("task-skill", projectId, { agentRuntimeType: "pi", taskId: task.id });
      const expanded =
        `<skill name="dip" location="/path/SKILL.md">body</skill>\n\n/dip run it`;
      persistMessages("task-skill", [
        { role: "user", content: [{ type: "text", text: expanded }] },
      ]);

      const list = listSessions({ taskId: task.id });
      expect(list).toHaveLength(1);
      expect(list[0].first_message).toBe("/dip run it");
    });
  });

  describe("updateSessionMeta", () => {
    test("applies partial updates", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      updateSessionMeta("sess-1", { name: "My Session" });
      const s = getSession("sess-1")!;
      expect(s.name).toBe("My Session");
      expect(s.thinking_level).toBe("off"); // unchanged
    });

    test("can update model fields", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      updateSessionMeta("sess-1", {
        modelProvider: "openai",
        modelId: "gpt-4",
        thinkingLevel: "medium",
      });
      const s = getSession("sess-1")!;
      expect(s.model_provider).toBe("openai");
      expect(s.model_id).toBe("gpt-4");
      expect(s.thinking_level).toBe("medium");
    });

    test("no-op for non-existent session", () => {
      // Should not throw
      updateSessionMeta("nonexistent", { name: "X" });
    });
  });

  describe("persistMessages", () => {
    test("inserts messages with correct seq ordering", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const msgs = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ];
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].role).toBe("user");
      expect(loaded[1].role).toBe("assistant");
    });

    test("is idempotent — re-calling with same messages inserts nothing new", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const msgs = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      persistMessages("sess-1", msgs);
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(1);
    });

    test("appends only new messages on subsequent calls", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      const batch1 = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      persistMessages("sess-1", batch1);

      const batch2 = [
        ...batch1,
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ];
      persistMessages("sess-1", batch2);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(2);
    });
  });

  describe("loadMessages", () => {
    test("returns empty array for session with no messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      expect(loadMessages("sess-1")).toEqual([]);
    });

    test("returns messages ordered by seq", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ]);

      const msgs = loadMessages("sess-1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe("first");
      expect(msgs[1].content).toBe("second");
      expect(msgs[2].content).toBe("third");
    });

    test("includes compaction markers", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "before compaction" },
        { role: "assistant", content: "reply" },
      ]);

      // Pi compacts and replaces in-memory array
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "discussed things" },
        { role: "user", content: "after compaction" },
      ]);

      const msgs = loadMessages("sess-1");
      const roles = msgs.map((m: any) => m.role);
      expect(roles).toContain("compactionSummary");
    });
  });

  describe("listSessionEntries", () => {
    test("filters persisted message entries and returns latest limited entries chronologically", () => {
      createSession("sess-query", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-query", [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: [{ type: "text", text: "second response" }] },
        { role: "user", content: [{ type: "thinking", thinking: "third thought" }] },
      ]);

      const latest = listSessionEntries("sess-query", { types: ["user", "assistant"], limit: 2 });

      expect(latest.map((m) => ({ seq: m.seq, type: m.type }))).toEqual([
        { seq: 1, type: "assistant" },
        { seq: 2, type: "user" },
      ]);
      expect(latest[0]).toMatchObject({ content: [{ type: "text", text: "second response" }] });
      expect(latest[1]).toMatchObject({ content: [{ type: "thinking", thinking: "third thought" }] });

      const searched = listSessionEntries("sess-query", { types: ["user"], search: "third" });
      expect(searched.map((m) => m.seq)).toEqual([2]);
    });

    test("extracts compact tool call and result entries directly from persisted messages", () => {
      createSession("sess-trace", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-trace", [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/a.ts" } }],
        },
        {
          role: "toolResult",
          toolCallId: "tc-read",
          toolName: "read",
          isError: false,
          content: "file contents",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll run a command" },
            { type: "toolCall", id: "tc-bash", name: "bash", arguments: { command: "exit 1" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc-bash",
          isError: true,
          content: [{ type: "text", text: "long failure output" }],
        },
      ]);

      expect(listSessionEntries("sess-trace", { types: ["toolCall", "toolResult"], toolName: "bash", includeContent: true })).toEqual([
        {
          sessionId: "sess-trace",
          seq: 2,
          created_at: expect.any(String),
          type: "toolCall",
          id: "tc-bash",
          name: "bash",
          arguments: { command: "exit 1" },
        },
        {
          sessionId: "sess-trace",
          seq: 3,
          created_at: expect.any(String),
          type: "toolResult",
          role: "toolResult",
          toolCallId: "tc-bash",
          toolName: "bash",
          isError: true,
          contentPreview: "long failure output",
          content: [{ type: "text", text: "long failure output" }],
        },
      ]);

      expect(listSessionEntries("sess-trace", { isError: true }).map((item) => item.seq)).toEqual([3]);
    });

    test("can return a combined session timeline with derived tool calls", () => {
      createSession("sess-entries", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-entries", [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect it" },
            { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "README.md" } },
          ],
        },
        { role: "toolResult", toolCallId: "tc-read", toolName: "read", isError: false, content: "contents" },
      ]);

      const entries = listSessionEntries("sess-entries", { types: ["user", "assistant", "toolCall"] });

      expect(entries.map((entry) => ({ seq: entry.seq, type: entry.type }))).toEqual([
        { seq: 0, type: "user" },
        { seq: 1, type: "assistant" },
        { seq: 1, type: "toolCall" },
      ]);
    });

    test("uses latest-window defaults but honors explicit ascending order for entry limits", () => {
      createSession("sess-trace-order", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-trace-order", [
        { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "one" } }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tc-2", name: "read", arguments: { path: "two" } }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tc-3", name: "read", arguments: { path: "three" } }] },
      ]);

      expect(listSessionEntries("sess-trace-order", { types: ["toolCall"], limit: 2 }).map((item) => item.seq)).toEqual([1, 2]);
      expect(listSessionEntries("sess-trace-order", { types: ["toolCall"], order: "asc", limit: 2 }).map((item) => item.seq)).toEqual([0, 1]);
      expect(listSessionEntries("sess-trace-order", { types: ["toolCall"], order: "desc", limit: 2 }).map((item) => item.seq)).toEqual([2, 1]);
    });
  });

  describe("loadMessagesForLLM", () => {
    test("returns all messages when no compaction has occurred", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      expect(msgs).toHaveLength(2);
    });

    test("returns compactionSummary and post-compaction messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "old message" },
        { role: "assistant", content: "old reply" },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary of old" },
        { role: "user", content: "new message" },
        { role: "assistant", content: "new reply" },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0].role).toBe("compactionSummary");
      expect(msgs[0].summary).toBe("summary of old");
      expect(msgs[1].content).toBe("new message");
      expect(msgs[2].content).toBe("new reply");
    });

    test("excludes pre-compaction messages from LLM context", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary" },
        { role: "user", content: "new" },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      const contents = msgs.map((m: any) => m.content || m.summary);
      expect(contents).not.toContain("old");
      expect(contents).not.toContain("old reply");
    });
  });

  describe("compaction", () => {
    test("persistMessages detects compactionSummary and creates boundary", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
      ]);

      // Pi compacts — in-memory array now starts with compactionSummary
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "discussed old topics" },
        { role: "user", content: "new question" },
      ]);

      const all = loadMessages("sess-1");
      // old(2) + compactionSummary(1) + new(1) = 4
      expect(all).toHaveLength(4);
      expect(all[2].role).toBe("compactionSummary");
      expect(all[3].content).toBe("new question");
    });

    test("preserves summary text from compactionSummary message", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
      ]);

      const summary = "## Goal\nBuild a widget\n\n## Progress\n- [x] Created skeleton";
      persistMessages("sess-1", [
        { role: "compactionSummary", summary },
        { role: "user", content: "new" },
      ]);

      const all = loadMessages("sess-1");
      const marker = all.find((m: any) => m.role === "compactionSummary");
      expect(marker).toBeDefined();
      expect(marker.summary).toBe(summary);
    });

    test("prunes tool result content from pre-compaction messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "question" },
        { role: "toolResult", content: [{ type: "text", text: "big result data" }] },
        { role: "assistant", content: "answer" },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary" },
        { role: "user", content: "post-compact msg" },
      ]);

      const all = loadMessages("sess-1");
      const toolResult = all.find((m: any) => m.role === "toolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult.content).toEqual([{ type: "text", text: "[pruned]" }]);
    });

    test("new messages persist correctly after compaction", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "msg 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "msg 2" },
        { role: "assistant", content: "reply 2" },
      ]);

      // Compaction replaces pi's in-memory array
      const postCompaction = [
        { role: "compactionSummary", summary: "compacted context" },
        { role: "user", content: "kept question" },
        { role: "assistant", content: "kept reply" },
      ];
      persistMessages("sess-1", postCompaction);

      // User continues — pi's array grows
      persistMessages("sess-1", [
        ...postCompaction,
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ]);

      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs.map((m: any) => m.content)).toContain("new question");
      expect(llmMsgs.map((m: any) => m.content)).toContain("new answer");

      const allMsgs = loadMessages("sess-1");
      const allContents = allMsgs.map((m: any) => m.content || m.summary);
      expect(allContents).toContain("new question");
      expect(allContents).toContain("new answer");
    });

    test("handles multiple compactions", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-1", [
        { role: "user", content: "batch 1" },
        { role: "assistant", content: "reply 1" },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary of batch 1" },
        { role: "user", content: "batch 2" },
        { role: "assistant", content: "reply 2" },
      ]);

      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary of batches 1-2" },
        { role: "user", content: "batch 3" },
      ]);

      // loadMessagesForLLM returns last compactionSummary + post-compaction messages
      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs).toHaveLength(2);
      expect(llmMsgs[0].role).toBe("compactionSummary");
      expect(llmMsgs[0].summary).toBe("summary of batches 1-2");
      expect(llmMsgs[1].content).toBe("batch 3");

      // Full history: pre-compaction + first CS + second CS + new post-compaction
      // Old post-compaction messages (batch 2, reply 2) are deleted during re-compaction
      // since they're now subsumed by the new compaction summary.
      const allMsgs = loadMessages("sess-1");
      const allRoles = allMsgs.map((m: any) => m.role);
      expect(allRoles.filter((r: string) => r === "compactionSummary")).toHaveLength(2);
      const allContents = allMsgs.map((m: any) => m.content || m.summary);
      expect(allContents).toContain("batch 1");
      expect(allContents).toContain("summary of batch 1");
      expect(allContents).toContain("summary of batches 1-2");
      expect(allContents).toContain("batch 3");
      // Old post-compaction messages are removed — they're subsumed by the new CS
      expect(allContents).not.toContain("batch 2");
      expect(allContents).not.toContain("reply 2");
    });

    test("re-compaction does not duplicate messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });

      // Initial messages
      persistMessages("sess-1", [
        { role: "user", content: "msg 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "msg 2" },
        { role: "assistant", content: "reply 2" },
      ]);

      // First compaction — pi's array is now [CS1, msg 2, reply 2]
      const postCompact1 = [
        { role: "compactionSummary", summary: "summary v1" },
        { role: "user", content: "msg 2" },
        { role: "assistant", content: "reply 2" },
      ];
      persistMessages("sess-1", postCompact1);

      // User continues — pi's array grows
      const continued = [
        ...postCompact1,
        { role: "user", content: "msg 3" },
        { role: "assistant", content: "reply 3" },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "tool output" }] },
        { role: "assistant", content: "reply 4" },
      ];
      persistMessages("sess-1", continued);

      // Re-compaction — pi compacts again, new summary subsumes everything
      const postCompact2 = [
        { role: "compactionSummary", summary: "summary v2" },
        { role: "assistant", content: "reply 4" },
      ];
      persistMessages("sess-1", postCompact2);

      // Verify no duplicates: each content value appears at most once
      const allMsgs = loadMessages("sess-1");
      const allContents = allMsgs.map((m: any) => m.content || m.summary);
      const duplicates = allContents.filter((c: string, i: number) => allContents.indexOf(c) !== i);
      expect(duplicates).toEqual([]);

      // LLM context uses only the latest compaction
      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs).toHaveLength(2);
      expect(llmMsgs[0].role).toBe("compactionSummary");
      expect(llmMsgs[0].summary).toBe("summary v2");
      expect(llmMsgs[1].content).toBe("reply 4");

      // Old post-compaction messages were deleted, not duplicated
      const msgContents = allMsgs.map((m: any) => m.content);
      expect(msgContents.filter((c: string) => c === "reply 4")).toHaveLength(1);
    });

    test("re-compaction prunes tool results from all pre-compaction messages", () => {
      createSession("sess-1", projectId, { agentRuntimeType: "pi" });

      // Messages with tool results
      persistMessages("sess-1", [
        { role: "user", content: "question" },
        { role: "toolResult", toolCallId: "tc0", content: [{ type: "text", text: "early tool output" }] },
        { role: "assistant", content: "answer" },
      ]);

      // First compaction
      const postCompact1 = [
        { role: "compactionSummary", summary: "summary v1" },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "kept tool output" }] },
        { role: "assistant", content: "reply" },
      ];
      persistMessages("sess-1", postCompact1);

      // Re-compaction
      persistMessages("sess-1", [
        { role: "compactionSummary", summary: "summary v2" },
        { role: "assistant", content: "final" },
      ]);

      const allMsgs = loadMessages("sess-1");

      // All toolResult messages before the latest compaction should be pruned
      const toolResults = allMsgs.filter((m: any) => m.role === "toolResult");
      for (const tr of toolResults) {
        expect(tr.content).toEqual([{ type: "text", text: "[pruned]" }]);
      }

      // No orphaned tool results in LLM context
      const llmMsgs = loadMessagesForLLM("sess-1");
      const llmToolResults = llmMsgs.filter((m: any) => m.role === "toolResult");
      expect(llmToolResults).toHaveLength(0);
    });
  });

  describe("listPaletteItems", () => {
    test("returns sessions across multiple projects", () => {
      const project2 = createProject("Project Two", "/tmp/project-two");

      createSession("sess-p1", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-p1", [
        { role: "user", content: [{ type: "text", text: "Hello from p1" }] },
      ]);

      createSession("sess-p2", project2.id, { agentRuntimeType: "pi" });
      persistMessages("sess-p2", [
        { role: "user", content: [{ type: "text", text: "Hello from p2" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(2);
      const projectNames = items.map((i) => i.projectName);
      expect(projectNames).toContain("Test Project");
      expect(projectNames).toContain("Project Two");
    });

    test("includes project name and task title", () => {
      const task = createTask(projectId, "Fix the bug", null, "task/fix-bug");
      createSession("sess-task", projectId, {  agentRuntimeType: "pi",taskId: task.id });
      persistMessages("sess-task", [
        { role: "user", content: [{ type: "text", text: "Working on bug" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].projectName).toBe("Test Project");
      expect(items[0].taskTitle).toBe("Fix the bug");
      expect(items[0].taskId).toBe(task.id);
    });

    test("excludes sessions with no messages", () => {
      createSession("sess-empty", projectId, { agentRuntimeType: "pi" });
      createSession("sess-with-msgs", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-with-msgs", [
        { role: "user", content: [{ type: "text", text: "Has content" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess-with-msgs");
    });

    test("excludes sub-sessions (parent_session_id not null)", () => {
      createSession("sess-parent", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-parent", [
        { role: "user", content: [{ type: "text", text: "Parent" }] },
      ]);

      createSession("sess-child", projectId, {  agentRuntimeType: "pi",parentSessionId: "sess-parent" });
      persistMessages("sess-child", [
        { role: "user", content: [{ type: "text", text: "Child" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess-parent");
    });

    test("orders by updated_at DESC", () => {
      const task1 = createTask(projectId, "Task A", null, "task/a");
      const task2 = createTask(projectId, "Task B", null, "task/b");

      createSession("sess-old", projectId, {  agentRuntimeType: "pi",taskId: task1.id });
      persistMessages("sess-old", [
        { role: "user", content: [{ type: "text", text: "Old" }] },
      ]);

      createSession("sess-new", projectId, {  agentRuntimeType: "pi",taskId: task2.id });
      persistMessages("sess-new", [
        { role: "user", content: [{ type: "text", text: "New" }] },
      ]);

      // Manually set updated_at to ensure ordering
      const { getDb } = require("../db.js");
      const db = getDb();
      db.query("UPDATE sessions SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = 'sess-new'").run();
      db.query("UPDATE sessions SET updated_at = '2025-01-02T00:00:00.000Z' WHERE id = 'sess-old'").run();

      const items = listPaletteItems();
      expect(items[0].sessionId).toBe("sess-old");
      expect(items[1].sessionId).toBe("sess-new");
    });

    test("only shows most recent assistant session per project", () => {
      createSession("sess-older", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-older", [
        { role: "user", content: [{ type: "text", text: "Older chat" }] },
      ]);

      createSession("sess-newer", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-newer", [
        { role: "user", content: [{ type: "text", text: "Newer chat" }] },
      ]);

      // Ensure sess-newer is clearly more recent
      const { getDb } = require("../db.js");
      const db = getDb();
      db.query("UPDATE sessions SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = 'sess-older'").run();
      db.query("UPDATE sessions SET updated_at = '2025-01-02T00:00:00.000Z' WHERE id = 'sess-newer'").run();

      const items = listPaletteItems();
      const assistantItems = items.filter((i) => i.taskId === null);
      expect(assistantItems).toHaveLength(1);
      expect(assistantItems[0].sessionId).toBe("sess-newer");
    });

    test("returns firstMessage correctly", () => {
      createSession("sess-msg", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-msg", [
        { role: "user", content: [{ type: "text", text: "My first question" }] },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [{ type: "text", text: "Follow up" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].firstMessage).toBe("My first question");
    });

    test("strips leading <skill> blocks from firstMessage preview", () => {
      createSession("sess-skill", projectId, { agentRuntimeType: "pi" });
      const expanded =
        `<skill name="dip" location="/path/SKILL.md">body content</skill>\n\n/dip start the server`;
      persistMessages("sess-skill", [
        { role: "user", content: [{ type: "text", text: expanded }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].firstMessage).toBe("/dip start the server");
    });

    test("returns null taskTitle for non-task sessions", () => {
      createSession("sess-free", projectId, { agentRuntimeType: "pi" });
      persistMessages("sess-free", [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].taskId).toBeNull();
      expect(items[0].taskTitle).toBeNull();
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
});
