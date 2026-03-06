import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createTask } from "../task-store.js";
import {
  createSession,
  getSession,
  listSessions,
  listTaskSessions,
  listPaletteItems,
  updateSessionMeta,
  persistMessages,
  loadMessages,
  loadMessagesForLLM,
  applyCompaction,
} from "../session-store.js";

let projectId: number;

describe("session-store", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Test Project", "/tmp/test-project");
    projectId = project.id;
  });

  describe("createSession", () => {
    test("returns full row with defaults", () => {
      const s = createSession("sess-1", projectId);
      expect(s.id).toBe("sess-1");
      expect(s.project_id).toBe(projectId);
      expect(s.name).toBeNull();
      expect(s.model_provider).toBeNull();
      expect(s.model_id).toBeNull();
      expect(s.thinking_level).toBe("off");
      expect(s.task_id).toBeNull();
      expect(s.parent_session_id).toBeNull();
      expect(s.created_at).toBeString();
      expect(s.updated_at).toBeString();
    });

    test("accepts optional fields", () => {
      // Create parent session first (FK constraint)
      createSession("sess-parent", projectId);
      const s = createSession("sess-2", projectId, {
        modelProvider: "anthropic",
        modelId: "claude-3",
        thinkingLevel: "high",
        taskId: undefined,
        parentSessionId: "sess-parent",
      });
      expect(s.model_provider).toBe("anthropic");
      expect(s.model_id).toBe("claude-3");
      expect(s.thinking_level).toBe("high");
      expect(s.parent_session_id).toBe("sess-parent");
    });

    test("can be linked to a task", () => {
      const task = createTask(projectId, "T", null, "task/t");
      const s = createSession("sess-t", projectId, { taskId: task.id });
      expect(s.task_id).toBe(task.id);
    });
  });

  describe("getSession", () => {
    test("returns the session by id", () => {
      createSession("sess-1", projectId);
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
      createSession("free-1", projectId);
      const task = createTask(projectId, "T", null, "task/t");
      createSession("task-1", projectId, { taskId: task.id });

      const list = listSessions(projectId);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("free-1");
    });

    test("includes message_count and first_message", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: [{ type: "text", text: "Hello world" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ]);

      const list = listSessions(projectId);
      expect(list).toHaveLength(1);
      expect(list[0].message_count).toBe(2);
      expect(list[0].first_message).toBe("Hello world");
    });

    test("ordered by updated_at DESC", () => {
      createSession("older", projectId);
      createSession("newer", projectId);

      // Touch 'older' to make it more recent
      persistMessages("older", [
        { role: "user", content: [{ type: "text", text: "bump" }] },
      ]);

      const list = listSessions(projectId);
      expect(list[0].id).toBe("older");
    });

    test("returns empty array when no sessions exist", () => {
      expect(listSessions(projectId)).toEqual([]);
    });
  });

  describe("listTaskSessions", () => {
    test("returns sessions scoped to a task", () => {
      const task = createTask(projectId, "T", null, "task/t");
      createSession("task-sess-1", projectId, { taskId: task.id });
      createSession("task-sess-2", projectId, { taskId: task.id });
      createSession("free-sess", projectId);

      const list = listTaskSessions(task.id);
      expect(list).toHaveLength(2);
      const ids = list.map((s) => s.id);
      expect(ids).toContain("task-sess-1");
      expect(ids).toContain("task-sess-2");
    });
  });

  describe("updateSessionMeta", () => {
    test("applies partial updates", () => {
      createSession("sess-1", projectId);
      updateSessionMeta("sess-1", { name: "My Session" });
      const s = getSession("sess-1")!;
      expect(s.name).toBe("My Session");
      expect(s.thinking_level).toBe("off"); // unchanged
    });

    test("can update model fields", () => {
      createSession("sess-1", projectId);
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
      createSession("sess-1", projectId);
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
      createSession("sess-1", projectId);
      const msgs = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ];
      persistMessages("sess-1", msgs);
      persistMessages("sess-1", msgs);

      const loaded = loadMessages("sess-1");
      expect(loaded).toHaveLength(1);
    });

    test("appends only new messages on subsequent calls", () => {
      createSession("sess-1", projectId);
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
      createSession("sess-1", projectId);
      expect(loadMessages("sess-1")).toEqual([]);
    });

    test("returns messages ordered by seq", () => {
      createSession("sess-1", projectId);
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
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "before compaction" },
      ]);
      applyCompaction("sess-1", [
        { role: "user", content: "after compaction" },
      ]);

      const msgs = loadMessages("sess-1");
      const roles = msgs.map((m: any) => m.role);
      expect(roles).toContain("compaction_summary");
    });
  });

  describe("loadMessagesForLLM", () => {
    test("returns all messages when no compaction has occurred", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      expect(msgs).toHaveLength(2);
    });

    test("returns only post-compaction messages", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "old message" },
      ]);
      applyCompaction("sess-1", [
        { role: "user", content: "new message" },
        { role: "assistant", content: "new reply" },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      expect(msgs).toHaveLength(2);
      expect(msgs[0].content).toBe("new message");
      expect(msgs[1].content).toBe("new reply");
    });

    test("excludes compaction_summary markers", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "old" },
      ]);
      applyCompaction("sess-1", [
        { role: "user", content: "new" },
      ]);

      const msgs = loadMessagesForLLM("sess-1");
      const roles = msgs.map((m: any) => m.role);
      expect(roles).not.toContain("compaction_summary");
    });
  });

  describe("applyCompaction", () => {
    test("inserts summary marker and post-compaction messages", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
      ]);

      applyCompaction("sess-1", [
        { role: "user", content: "summary context" },
      ]);

      const all = loadMessages("sess-1");
      // old(2) + compaction_summary(1) + new(1) = 4
      expect(all).toHaveLength(4);
      expect(all[2].role).toBe("compaction_summary");
      expect(all[3].content).toBe("summary context");
    });

    test("prunes tool result content from pre-compaction messages", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "question" },
        { role: "toolResult", content: [{ type: "text", text: "big result data" }] },
        { role: "assistant", content: "answer" },
      ]);

      applyCompaction("sess-1", [
        { role: "user", content: "post-compact msg" },
      ]);

      const all = loadMessages("sess-1");
      // Find the toolResult message (should be at index 1)
      const toolResult = all.find((m: any) => m.role === "toolResult");
      expect(toolResult).toBeDefined();
      expect(toolResult.content).toEqual([{ type: "text", text: "[pruned]" }]);
    });

    test("handles multiple compactions", () => {
      createSession("sess-1", projectId);
      persistMessages("sess-1", [
        { role: "user", content: "batch 1" },
      ]);

      applyCompaction("sess-1", [
        { role: "user", content: "batch 2" },
      ]);

      applyCompaction("sess-1", [
        { role: "user", content: "batch 3" },
      ]);

      // loadMessagesForLLM should only return messages after the LAST compaction
      const llmMsgs = loadMessagesForLLM("sess-1");
      expect(llmMsgs).toHaveLength(1);
      expect(llmMsgs[0].content).toBe("batch 3");
    });
  });

  describe("listPaletteItems", () => {
    test("returns sessions across multiple projects", () => {
      const project2 = createProject("Project Two", "/tmp/project-two");

      createSession("sess-p1", projectId);
      persistMessages("sess-p1", [
        { role: "user", content: [{ type: "text", text: "Hello from p1" }] },
      ]);

      createSession("sess-p2", project2.id);
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
      createSession("sess-task", projectId, { taskId: task.id });
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
      createSession("sess-empty", projectId);
      createSession("sess-with-msgs", projectId);
      persistMessages("sess-with-msgs", [
        { role: "user", content: [{ type: "text", text: "Has content" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess-with-msgs");
    });

    test("excludes sub-sessions (parent_session_id not null)", () => {
      createSession("sess-parent", projectId);
      persistMessages("sess-parent", [
        { role: "user", content: [{ type: "text", text: "Parent" }] },
      ]);

      createSession("sess-child", projectId, { parentSessionId: "sess-parent" });
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

      createSession("sess-old", projectId, { taskId: task1.id });
      persistMessages("sess-old", [
        { role: "user", content: [{ type: "text", text: "Old" }] },
      ]);

      createSession("sess-new", projectId, { taskId: task2.id });
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
      createSession("sess-older", projectId);
      persistMessages("sess-older", [
        { role: "user", content: [{ type: "text", text: "Older chat" }] },
      ]);

      createSession("sess-newer", projectId);
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
      createSession("sess-msg", projectId);
      persistMessages("sess-msg", [
        { role: "user", content: [{ type: "text", text: "My first question" }] },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: [{ type: "text", text: "Follow up" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].firstMessage).toBe("My first question");
    });

    test("returns null taskTitle for non-task sessions", () => {
      createSession("sess-free", projectId);
      persistMessages("sess-free", [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].taskId).toBeNull();
      expect(items[0].taskTitle).toBeNull();
    });
  });
});
