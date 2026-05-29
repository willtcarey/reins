import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo, createTestRepo } from "../helpers/test-repo.js";
import { createProject, type Project } from "../../project-store.js";
import { createTask, getTask } from "../../task-store.js";
import { createSession as storeCreateSession } from "../../session-store.js";
import { persistMessages } from "../../messages-store.js";
import { getDb } from "../../db.js";
import { createExecuteTool } from "../../tools/execute.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";
import { createStrictExtensionContext } from "../helpers/test-pi.js";
import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";

const strictCtx = createStrictExtensionContext();

// Initialize encryption secret for tests
initEncryptionSecret(randomBytes(32));

/** Extract text from the first content item. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item.type !== "text" || !item.text) throw new Error("Expected text content");
  return item.text;
}

describe("createExecuteTool", () => {
  let project: Project;
  let broadcastSpy: ReturnType<typeof mock>;
  let broadcast: Broadcast;
  let sessions: Map<string, ManagedSession>;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    project = createProject("Test Project", repo.dir, "main");
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    broadcast = broadcastSpy;
    sessions = new Map();
  });

  function makeTool(sessionId = "test-session", taskId: number | null = null) {
    return createExecuteTool({
      projectId: project.id,
      sessionId,
      taskId,
      broadcast,
      sessions,
    });
  }

  describe("tool definition shape", () => {
    test("returns a valid ToolDefinition", () => {
      const tool = makeTool();
      expect(tool.name).toBe("execute");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    test("has a label", () => {
      const tool = makeTool();
      expect(tool.label).toBe("Execute");
    });

  });

  describe("projects API", () => {
    test("projects.current() returns the current project", async () => {
      const tool = makeTool();
      const result = await tool.execute("c1", {
        code: "return api.projects.current()",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.id).toBe(project.id);
      expect(parsed.name).toBe("Test Project");
    });

    test("projects.list() returns all projects", async () => {
      const tool = makeTool();
      const result = await tool.execute("c2", {
        code: "return api.projects.list()",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed).toBeArray();
      expect(parsed.length).toBeGreaterThanOrEqual(1);
    });

    test("projects.get() returns a project by ID", async () => {
      const tool = makeTool();
      const result = await tool.execute("c3", {
        code: `return api.projects.get(${project.id})`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.id).toBe(project.id);
    });

    test("projects.get() throws for nonexistent ID", async () => {
      const tool = makeTool();
      const result = await tool.execute("c4", {
        code: "return api.projects.get(99999)",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toContain("Error:");
    });

    test("projects.create() creates a new project", async () => {
      const secondRepo = await createTestRepo();
      try {
        const tool = makeTool();
        const result = await tool.execute("c-create", {
          code: `return await api.projects.create("New Project", ${JSON.stringify(secondRepo.dir)})`,
        }, undefined, undefined, strictCtx);

        const parsed = JSON.parse(textOf(result));
        expect(parsed.name).toBe("New Project");
        expect(parsed.path).toBe(secondRepo.dir);
        expect(parsed.base_branch).toBe("main");
        expect(parsed.id).toBeGreaterThan(0);
      } finally {
        secondRepo.cleanup();
      }
    });

    test("projects.create() throws on duplicate path", async () => {
      const tool = makeTool();
      // repo.dir is already used by the project created in beforeEach
      const result = await tool.execute("c-dup", {
        code: `return await api.projects.create("Dupe", ${JSON.stringify(repo.dir)})`,
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toContain("Error:");
      expect(textOf(result)).toContain("already exists");
    });
  });

  describe("tasks API", () => {
    test("tasks.list() returns tasks for the current project", async () => {
      createTask(project.id, "Task 1", "desc", "task/one", null);
      createTask(project.id, "Task 2", "desc", "task/two", null);

      const tool = makeTool();
      const result = await tool.execute("c5", {
        code: "return api.tasks.list()",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed).toBeArray();
      expect(parsed.length).toBe(2);
    });

    test("tasks.current() returns the task for the current session", async () => {
      const task = createTask(project.id, "Current Task", "desc", "task/current", null);
      storeCreateSession("task-sess", project.id, { agentRuntimeType: "pi", taskId: task.id });
      const tool = makeTool("task-sess", task.id);

      const result = await tool.execute("c-tc", {
        code: "return api.tasks.current()",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.id).toBe(task.id);
      expect(parsed.title).toBe("Current Task");
    });

    test("tasks.current() returns null for scratch sessions", async () => {
      const tool = makeTool("scratch-sess", null);
      const result = await tool.execute("c-tc2", {
        code: "return api.tasks.current()",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toBe("null");
    });

    test("tasks.get() returns a task by ID", async () => {
      const task = createTask(project.id, "My Task", "description", "task/my-task", null);

      const tool = makeTool();
      const result = await tool.execute("c6", {
        code: `return api.tasks.get(${task.id})`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.id).toBe(task.id);
      expect(parsed.title).toBe("My Task");
    });

    test("tasks.create() creates a task with a git branch", async () => {
      const tool = makeTool();
      const result = await tool.execute("c7", {
        code: `return await api.tasks.create("New Task", "A new task")`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.title).toBe("New Task");
      expect(parsed.branch_name).toContain("task/");

      // Verify in DB
      const dbTask = getTask(parsed.id);
      expect(dbTask).not.toBeNull();
      expect(dbTask!.title).toBe("New Task");
    });

    test("tasks.update() updates a task", async () => {
      const task = createTask(project.id, "Original", "desc", "task/orig", null);

      const tool = makeTool();
      const result = await tool.execute("c8", {
        code: `return api.tasks.update(${task.id}, { title: "Updated" })`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.title).toBe("Updated");
    });
  });

  describe("sessions API", () => {
    test("sessions.list() returns all sessions for the current project", async () => {
      const task = createTask(project.id, "List Task", "desc", "task/list", null);
      storeCreateSession("sess-1", project.id, { agentRuntimeType: "pi" });
      storeCreateSession("sess-2", project.id, { agentRuntimeType: "pi" });
      storeCreateSession("task-sess", project.id, { agentRuntimeType: "pi", taskId: task.id });

      const tool = makeTool();
      const result = await tool.execute("c9", {
        code: "return api.sessions.list()",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed).toBeArray();
      expect(parsed.map((s: any) => s.id).toSorted()).toEqual(["sess-1", "sess-2", "task-sess"]);
    });

    test("sessions.current() returns the current session", async () => {
      storeCreateSession("current-sess", project.id, { agentRuntimeType: "pi" });
      const tool = makeTool("current-sess");

      const result = await tool.execute("c-sc", {
        code: "return api.sessions.current()",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.id).toBe("current-sess");
    });

    test("sessions.get() returns a session by ID", async () => {
      storeCreateSession("sess-x", project.id, { agentRuntimeType: "pi" });

      const tool = makeTool();
      const result = await tool.execute("c11", {
        code: `return api.sessions.get("sess-x")`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.id).toBe("sess-x");
    });

    test("sessions.entries() returns persisted message entries", async () => {
      storeCreateSession("sess-m", project.id, { agentRuntimeType: "pi" });
      persistMessages("sess-m", [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      ]);

      const tool = makeTool();
      const result = await tool.execute("c12", {
        code: `return api.sessions.entries("sess-m")`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed).toBeArray();
      expect(parsed.length).toBe(2);
      expect(parsed[0]).toMatchObject({ role: "user", type: "user" });
    });

    test("session read methods can inspect sessions from another project", async () => {
      const otherProject = createProject("Other Project", `${repo.dir}-other-read`, "main");
      storeCreateSession("other-read", otherProject.id, { agentRuntimeType: "pi" });
      persistMessages("other-read", [
        { role: "user", content: [{ type: "text", text: "Hello from another project" }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-other", name: "read", arguments: { path: "README.md" } }],
        },
        {
          role: "toolResult",
          toolCallId: "tc-other",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "other project file" }],
        },
      ]);

      const tool = makeTool();
      const result = await tool.execute("c-cross-project-session-reads", {
        code: `return {
          session: api.sessions.get("other-read"),
          messages: api.sessions.entries("other-read", { types: ["user", "assistant"], limit: 1 }),
          trace: api.sessions.entries("other-read", { types: ["toolCall"] }),
        }`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.session.project_id).toBe(otherProject.id);
      expect(parsed.messages[0].role).toBe("assistant");
      expect(parsed.trace).toHaveLength(1);
      expect(parsed.trace[0]).toMatchObject({
        type: "toolCall",
        id: "tc-other",
        name: "read",
        result: { isError: false, contentPreview: "other project file" },
      });
    });

    test("sessions.list(options) filters by search, minMessages, since, and limit", async () => {
      storeCreateSession("old-match", project.id, { agentRuntimeType: "pi" });
      persistMessages("old-match", [
        { role: "user", content: [{ type: "text", text: "needle old prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ]);

      storeCreateSession("new-low-count", project.id, { agentRuntimeType: "pi" });
      persistMessages("new-low-count", [
        { role: "user", content: [{ type: "text", text: "needle but only one message" }] },
      ]);

      storeCreateSession("new-match", project.id, { agentRuntimeType: "pi" });
      persistMessages("new-match", [
        { role: "user", content: [{ type: "text", text: "needle new prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "new answer" }] },
      ]);

      getDb().query("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", "old-match");
      getDb().query("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2024-03-01T00:00:00.000Z", "new-low-count");
      getDb().query("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2024-03-02T00:00:00.000Z", "new-match");

      const tool = makeTool();
      const result = await tool.execute("c-list-filter", {
        code: `return api.sessions.list({ search: "needle", minMessages: 2, since: "2024-02-01T00:00:00.000Z", limit: 1 })`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.map((s: any) => s.id)).toEqual(["new-match"]);
      expect(parsed[0].message_count).toBe(2);
      expect(parsed[0].first_message).toBe("needle new prompt");
    });

    test("sessions.list(options) can list task sessions through taskId", async () => {
      const task = createTask(project.id, "Task Sessions", "desc", "task/sessions", null);
      storeCreateSession("scratch-only", project.id, { agentRuntimeType: "pi" });
      storeCreateSession("task-only", project.id, { agentRuntimeType: "pi", taskId: task.id });

      const tool = makeTool();
      const result = await tool.execute("c-list-task", {
        code: `return api.sessions.list({ taskId: ${task.id} })`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.map((s: any) => s.id)).toEqual(["task-only"]);
    });

    test("sessions.list(options) can list scratch sessions through taskId null", async () => {
      const task = createTask(project.id, "Task Sessions", "desc", "task/sessions-null", null);
      storeCreateSession("scratch-only", project.id, { agentRuntimeType: "pi" });
      storeCreateSession("task-only", project.id, { agentRuntimeType: "pi", taskId: task.id });

      const tool = makeTool();
      const result = await tool.execute("c-list-scratch", {
        code: "return api.sessions.list({ taskId: null })",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.map((s: any) => s.id)).toEqual(["scratch-only"]);
    });

    test("sessions.list(options) accepts current project and task identifiers", async () => {
      const task = createTask(project.id, "Current Task Sessions", "desc", "task/current-sessions", null);
      storeCreateSession("scratch-only", project.id, { agentRuntimeType: "pi" });
      storeCreateSession("task-current", project.id, { agentRuntimeType: "pi", taskId: task.id });
      storeCreateSession("task-context", project.id, { agentRuntimeType: "pi", taskId: task.id });

      const tool = makeTool("task-context", task.id);
      const result = await tool.execute("c-list-current-identifiers", {
        code: `return api.sessions.list({ projectId: "current", taskId: "current" })`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.map((s: any) => s.id).toSorted()).toEqual(["task-context", "task-current"]);
    });

    test("sessions.list(options) can target another project", async () => {
      const otherProject = createProject("Other Project", `${repo.dir}-other`, "main");
      storeCreateSession("current-project", project.id, { agentRuntimeType: "pi" });
      persistMessages("current-project", [
        { role: "user", content: [{ type: "text", text: "scope needle current" }] },
      ]);
      storeCreateSession("other-project", otherProject.id, { agentRuntimeType: "pi" });
      persistMessages("other-project", [
        { role: "user", content: [{ type: "text", text: "scope needle other" }] },
      ]);

      const tool = makeTool();
      const result = await tool.execute("c-list-other-project", {
        code: `return api.sessions.list({ projectId: ${otherProject.id}, search: "scope needle" })`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed.map((s: any) => s.id)).toEqual(["other-project"]);
    });

    test("sessions.entries(sessionId, options) filters and pages entries with metadata", async () => {
      storeCreateSession("sess-filter", project.id, { agentRuntimeType: "pi" });
      persistMessages("sess-filter", [
        { role: "user", content: [{ type: "text", text: "first prompt" }] },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: [{ type: "text", text: "second prompt needle" }] },
        { role: "assistant", content: [{ type: "text", text: "second answer" }] },
      ]);

      const tool = makeTool();
      const result = await tool.execute("c-msg-filter", {
        code: `return api.sessions.entries("sess-filter", { types: ["user"], search: "needle", limit: 1 })`,
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ role: "user", type: "user" });
      expect(parsed[0].seq).toBe(2);
      expect(parsed[0].created_at).toBeString();
    });

    test("sessions.entries(sessionId, { limit }) returns the latest entries in chronological order", async () => {
      storeCreateSession("sess-latest", project.id, { agentRuntimeType: "pi" });
      persistMessages("sess-latest", [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: [{ type: "text", text: "three" }] },
      ]);

      const tool = makeTool();
      const result = await tool.execute("c-msg-limit", {
        code: `return api.sessions.entries("sess-latest", { types: ["user", "assistant"], limit: 2 }).map((m) => ({ seq: m.seq, type: m.type }))`,
      }, undefined, undefined, strictCtx);

      expect(JSON.parse(textOf(result))).toEqual([
        { seq: 1, type: "assistant" },
        { seq: 2, type: "user" },
      ]);
    });

    test("sessions.entries() exposes compact tool entries", async () => {
      storeCreateSession("sess-tools", project.id, { agentRuntimeType: "pi" });
      persistMessages("sess-tools", [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect a file" },
            { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/a.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc-read",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file contents" }],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-bash", name: "bash", arguments: { command: "exit 1" } }],
        },
        {
          role: "toolResult",
          toolCallId: "tc-bash",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "a very long failure output" }],
        },
      ]);

      const tool = makeTool();
      const traceResult = await tool.execute("c-tool-trace", {
        code: `return api.sessions.entries("sess-tools", { types: ["toolCall"], toolName: "bash" })`,
      }, undefined, undefined, strictCtx);
      const errorResult = await tool.execute("c-tool-error-trace", {
        code: `return api.sessions.entries("sess-tools", { isError: true })`,
      }, undefined, undefined, strictCtx);

      const trace = JSON.parse(textOf(traceResult));
      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        type: "toolCall",
        id: "tc-bash",
        name: "bash",
        arguments: { command: "exit 1" },
        result: {
          isError: true,
          contentPreview: "a very long failure output",
        },
      });
      expect(trace[0].result.content).toBeUndefined();

      const errors = JSON.parse(textOf(errorResult));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "toolCall", id: "tc-bash", name: "bash", result: { isError: true } });
    });
  });

  describe("ui API", () => {
    test("ui.broadcast() sends an arbitrary frontend message", async () => {
      const tool = makeTool("test-session");
      const message: ServerMessage = {
        type: "event",
        sessionId: "test-session",
        projectId: project.id,
        event: { type: "compaction_start", reason: "debug" },
      };

      const result = await tool.execute("c-ui-broadcast", {
        code: `return api.ui.broadcast(${JSON.stringify(message)})`,
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toBe("Broadcast sent");
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy.mock.calls[0][0]).toEqual(message);
    });
  });

  describe("error handling", () => {
    test("returns error for syntax errors", async () => {
      const tool = makeTool();
      const result = await tool.execute("err-1", {
        code: "return {{{",
      }, undefined, undefined, strictCtx);

      const text = textOf(result);
      expect(text).toContain("Error:");
    });

    test("returns error for runtime exceptions", async () => {
      const tool = makeTool();
      const result = await tool.execute("err-2", {
        code: "throw new Error('boom')",
      }, undefined, undefined, strictCtx);

      const text = textOf(result);
      expect(text).toContain("Error:");
      expect(text).toContain("boom");
    });

    test("cannot access require or import", async () => {
      const tool = makeTool();
      // The function body runs in a scoped context — require isn't available
      const result = await tool.execute("err-3", {
        code: "const fs = require('fs'); return fs.readFileSync('/etc/passwd', 'utf8')",
      }, undefined, undefined, strictCtx);

      const text = textOf(result);
      expect(text).toContain("Error:");
    });

    test("cannot access process", async () => {
      const tool = makeTool();
      const result = await tool.execute("err-4", {
        code: "return process.env",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toContain("Error:");
    });

    test("cannot access globalThis.process", async () => {
      const tool = makeTool();
      const result = await tool.execute("err-5", {
        code: "return globalThis.process",
      }, undefined, undefined, strictCtx);

      // globalThis in vm context is the sandbox — process isn't on it
      expect(textOf(result)).toBe("undefined");
    });

    test("cannot use dynamic import", async () => {
      const tool = makeTool();
      const result = await tool.execute("err-6", {
        code: "const fs = await import('fs'); return fs.readdirSync('.')",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toContain("Error:");
    });

    test("cannot access fetch", async () => {
      const tool = makeTool();
      const result = await tool.execute("err-7", {
        code: "return typeof fetch",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toBe("undefined");
    });
  });

  describe("return value formatting", () => {
    test("serializes objects as JSON", async () => {
      const tool = makeTool();
      const result = await tool.execute("f1", {
        code: "return { a: 1, b: 'two' }",
      }, undefined, undefined, strictCtx);

      const parsed = JSON.parse(textOf(result));
      expect(parsed).toEqual({ a: 1, b: "two" });
    });

    test("returns undefined as 'undefined'", async () => {
      const tool = makeTool();
      const result = await tool.execute("f2", {
        code: "// no return",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toBe("undefined");
    });

    test("returns primitives directly", async () => {
      const tool = makeTool();
      const result = await tool.execute("f3", {
        code: "return 42",
      }, undefined, undefined, strictCtx);

      expect(textOf(result)).toBe("42");
    });
  });
});
