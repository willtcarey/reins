import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { getDb } from "../app-globals.js";
import { createProject } from "./project-fixture.js";
import { createTask, setTaskStatus } from "../task-store.js";
import {
  createSession,
  getSession,
  listSessions,
  listPaletteItems,
  updateSessionMeta,
  updateActivityState,
  updateSessionMetadata,
} from "./session-fixture.js";
import { persistCanonicalMessages } from "./helpers/canonical-messages.js";
import { stubRuntime, testProcess } from "./helpers/app-state.js";
import { listSessionsWithActivity } from "../session-store.js";

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
      expect(s.activity_state).toBeNull();
      expect(s.pinned_at).toBeNull();
      expect(s.archived_at).toBeNull();
      expect(s.background).toBe(0);
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
      persistCanonicalMessages("sess-1", [
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
      persistCanonicalMessages("sess-full", [
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

    test("ordered by updated_at DESC, not by creation", () => {
      createSession("created-first", projectId, { agentRuntimeType: "pi" });
      createSession("created-last", projectId, { agentRuntimeType: "pi" });
      const db = getDb();
      db.query("UPDATE sessions SET updated_at = '2025-01-02T00:00:00.000Z' WHERE id = 'created-first'").run();
      db.query("UPDATE sessions SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = 'created-last'").run();

      expect(listSessions({ projectId, taskId: null }).map((session) => session.id)).toEqual(["created-first", "created-last"]);
    });

    test("puts pinned sessions first while preserving recency within pinned and unpinned groups", () => {
      for (const id of ["pinned-old", "pinned-new", "regular-old", "regular-new"]) {
        createSession(id, projectId, { agentRuntimeType: "pi" });
      }
      const db = getDb();
      db.query("UPDATE sessions SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id IN ('pinned-old', 'regular-old')").run();
      db.query("UPDATE sessions SET updated_at = '2025-01-02T00:00:00.000Z' WHERE id IN ('pinned-new', 'regular-new')").run();
      updateSessionMetadata("pinned-old", { pinned: true });
      updateSessionMetadata("pinned-new", { pinned: true });

      expect(listSessions({ projectId, taskId: null }).map((session) => session.id)).toEqual([
        "pinned-new",
        "pinned-old",
        "regular-new",
        "regular-old",
      ]);
    });

    test("excludes archived sessions without changing pin state", () => {
      createSession("active", projectId, { agentRuntimeType: "pi" });
      createSession("archived-pinned", projectId, { agentRuntimeType: "pi" });
      updateSessionMetadata("archived-pinned", { pinned: true, archived: true });

      expect(listSessions({ projectId, taskId: null }).map((session) => session.id)).toEqual(["active"]);
      expect(getSession("archived-pinned")).toMatchObject({
        pinned_at: expect.any(String),
        archived_at: expect.any(String),
      });
    });

    test("excludes background sessions unless asked for them", () => {
      const task = createTask(projectId, "T", null, "task/t");
      createSession("visible", projectId, { agentRuntimeType: "pi", taskId: task.id });
      createSession("hidden", projectId, { agentRuntimeType: "pi", taskId: task.id, background: true });

      expect(listSessions({ projectId, includeTaskSessions: true }).map((session) => session.id)).toEqual(["visible"]);
      expect(listSessions({ taskId: task.id }).map((session) => session.id)).toEqual(["visible"]);
      expect(listSessions({ taskId: task.id, background: "only" }).map((session) => session.id)).toEqual(["hidden"]);
      expect(listSessions({ taskId: task.id, background: "include" }).map((session) => session.id).toSorted()).toEqual(["hidden", "visible"]);
    });

    test("updates pin and archive independently without cascading to related sessions", () => {
      const task = createTask(projectId, "T", null, "task/t");
      createSession("parent", projectId, { agentRuntimeType: "pi", taskId: task.id });
      createSession("child", projectId, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: "parent" });
      updateSessionMetadata("parent", { pinned: true, archived: true });
      updateSessionMetadata("parent", { archived: false });

      expect(getSession("parent")).toMatchObject({ pinned_at: expect.any(String), archived_at: null });
      expect(getSession("child")).toMatchObject({ pinned_at: null, archived_at: null });
    });

    test("activity updates do not unarchive a session", () => {
      createSession("archived", projectId, { agentRuntimeType: "pi" });
      updateSessionMetadata("archived", { archived: true });
      const archivedAt = getSession("archived")!.archived_at;

      updateActivityState("archived", "finished");
      persistCanonicalMessages("archived", [{ role: "user", content: [{ type: "text", text: "new work" }] }]);

      expect(getSession("archived")!.archived_at).toBe(archivedAt);
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
      persistCanonicalMessages("sess-skill", [
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
      persistCanonicalMessages("task-skill", [
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

  describe("activity_state", () => {
    /** Session `id` with `stored` as its row's activity_state. */
    const withStored = (id: string, stored: "finished" | null, opts: { background?: boolean } = {}) => {
      createSession(id, projectId, { agentRuntimeType: "pi", ...opts });
      getDb().query("UPDATE sessions SET activity_state = ? WHERE id = ?").run(stored, id);
    };

    test("is running while the process has the session busy, else the stored finished or null", () => {
      const serverProcess = testProcess();
      const { sessions } = serverProcess;
      withStored("submitting", null);
      sessions.submissions.set("submitting", Promise.resolve());
      withStored("busy", "finished");
      stubRuntime(serverProcess, "busy");
      withStored("idle", "finished");
      stubRuntime(serverProcess, "idle", { busy: () => false });
      // Being opened (recovery's resume) with an operation Pi has in progress; and with none.
      withStored("resuming", null);
      getDb().query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES ('resuming', 'pi.lane.state', 'main', 1, ?), ('resuming', 'pi.op.meta', 'op-1', 2, ?)")
        .run(JSON.stringify({ currentOperationId: "op-1", lastOperationId: null, inbox: [] }), JSON.stringify({ operationId: "op-1", lane: "main", sourceTipId: null, startedAt: 1, intent: { kind: "run", promptEntryIds: [] } }));
      sessions.opening.set("resuming", new Promise(() => {}));
      withStored("opening", null);
      sessions.opening.set("opening", new Promise(() => {}));
      withStored("background", null, { background: true });
      stubRuntime(serverProcess, "background");

      const expected: Record<string, "running" | "finished" | null> = {
        submitting: "running", busy: "running", idle: "finished", resuming: "running", opening: null, background: "running",
      };
      for (const [id, activity] of Object.entries(expected)) expect([id, getSession(id)!.activity_state]).toEqual([id, activity]);
      expect(Object.fromEntries(listSessions({ projectId, background: "include" }).map(row => [row.id, row.activity_state]))).toEqual(expected);
      // The activity snapshot: every session with activity, background ones left out.
      expect(listSessionsWithActivity().map(row => [row.id, row.activity_state]).toSorted()).toEqual([
        ["busy", "running"], ["idle", "finished"], ["resuming", "running"], ["submitting", "running"],
      ]);
    });

    test("with no process (a standalone tool), nothing runs: the stored value reads as it is", () => {
      withStored("idle", null);
      withStored("finished", "finished");
      expect(getSession("idle")!.activity_state).toBeNull();
      expect(getSession("finished")!.activity_state).toBe("finished");
      expect(listSessionsWithActivity().map(row => row.id)).toEqual(["finished"]);
    });
  });

  describe("listPaletteItems", () => {
    test("excludes archived sessions", () => {
      createSession("active", projectId, { agentRuntimeType: "pi" });
      createSession("archived", projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages("active", [{ role: "user", content: [{ type: "text", text: "active" }] }]);
      persistCanonicalMessages("archived", [{ role: "user", content: [{ type: "text", text: "archived" }] }]);
      updateSessionMetadata("archived", { archived: true });

      expect(listPaletteItems().map((item) => item.sessionId)).toEqual(["active"]);
    });

    test("excludes background sessions", () => {
      const task = createTask(projectId, "T", null, "task/t");
      createSession("scratch", projectId, { agentRuntimeType: "pi" });
      createSession("background-scratch", projectId, { agentRuntimeType: "pi", background: true });
      createSession("background-task", projectId, { agentRuntimeType: "pi", taskId: task.id, background: true });
      for (const id of ["scratch", "background-scratch", "background-task"]) {
        persistCanonicalMessages(id, [{ role: "user", content: [{ type: "text", text: id }] }]);
      }

      expect(listPaletteItems().map((item) => item.sessionId)).toEqual(["scratch"]);
    });

    test("excludes closed-task sessions while retaining open-task and scratch sessions", () => {
      const openTask = createTask(projectId, "Open", null, "task/open");
      const closedTask = createTask(projectId, "Closed", null, "task/closed");
      setTaskStatus(closedTask.id, "closed");

      for (const [id, taskId] of [
        ["open", openTask.id],
        ["closed", closedTask.id],
        ["scratch", undefined],
      ] as const) {
        createSession(id, projectId, { agentRuntimeType: "pi", taskId });
        persistCanonicalMessages(id, [{ role: "user", content: [{ type: "text", text: id }] }]);
      }

      expect(listPaletteItems().map((item) => item.sessionId).toSorted()).toEqual([
        "open",
        "scratch",
      ]);
    });

    test("returns sessions across multiple projects", () => {
      const project2 = createProject("Project Two", "/tmp/project-two");

      createSession("sess-p1", projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages("sess-p1", [
        { role: "user", content: [{ type: "text", text: "Hello from p1" }] },
      ]);

      createSession("sess-p2", project2.id, { agentRuntimeType: "pi" });
      persistCanonicalMessages("sess-p2", [
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
      persistCanonicalMessages("sess-task", [
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
      persistCanonicalMessages("sess-with-msgs", [
        { role: "user", content: [{ type: "text", text: "Has content" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].sessionId).toBe("sess-with-msgs");
    });

    test("excludes sub-sessions (parent_session_id not null)", () => {
      createSession("sess-parent", projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages("sess-parent", [
        { role: "user", content: [{ type: "text", text: "Parent" }] },
      ]);

      createSession("sess-child", projectId, {  agentRuntimeType: "pi",parentSessionId: "sess-parent" });
      persistCanonicalMessages("sess-child", [
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
      persistCanonicalMessages("sess-old", [
        { role: "user", content: [{ type: "text", text: "Old" }] },
      ]);

      createSession("sess-new", projectId, {  agentRuntimeType: "pi",taskId: task2.id });
      persistCanonicalMessages("sess-new", [
        { role: "user", content: [{ type: "text", text: "New" }] },
      ]);

      // Manually set updated_at to ensure ordering
      const db = getDb();
      db.query("UPDATE sessions SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = 'sess-new'").run();
      db.query("UPDATE sessions SET updated_at = '2025-01-02T00:00:00.000Z' WHERE id = 'sess-old'").run();

      const items = listPaletteItems();
      expect(items[0].sessionId).toBe("sess-old");
      expect(items[1].sessionId).toBe("sess-new");
    });

    test("only shows most recent assistant session per project", () => {
      createSession("sess-older", projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages("sess-older", [
        { role: "user", content: [{ type: "text", text: "Older chat" }] },
      ]);

      createSession("sess-newer", projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages("sess-newer", [
        { role: "user", content: [{ type: "text", text: "Newer chat" }] },
      ]);

      // Ensure sess-newer is clearly more recent
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
      persistCanonicalMessages("sess-msg", [
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
      persistCanonicalMessages("sess-skill", [
        { role: "user", content: [{ type: "text", text: expanded }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].firstMessage).toBe("/dip start the server");
    });

    test("returns null taskTitle for non-task sessions", () => {
      createSession("sess-free", projectId, { agentRuntimeType: "pi" });
      persistCanonicalMessages("sess-free", [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ]);

      const items = listPaletteItems();
      expect(items).toHaveLength(1);
      expect(items[0].taskId).toBeNull();
      expect(items[0].taskTitle).toBeNull();
    });
  });

  describe("activity state", () => {
    describe("updateActivityState", () => {
      test("stores the unread flag: NULL → finished → NULL", () => {
        const session = createSession("sess-1", projectId, { agentRuntimeType: "pi" });
        expect(session.activity_state).toBeNull();

        updateActivityState("sess-1", "finished");
        expect(getSession("sess-1")!.activity_state).toBe("finished");

        updateActivityState("sess-1", null);
        expect(getSession("sess-1")!.activity_state).toBeNull();
      });

    });

  });

});
