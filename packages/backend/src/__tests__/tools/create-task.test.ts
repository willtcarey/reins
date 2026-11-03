import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Models } from "../../models/models.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { localGit } from "../helpers/local-git.js";
import { createProject } from "../project-fixture.js";
import { getTask } from "../../task-store.js";
import { SessionInstance } from "../../sessions/session-instance.js";
import { createAppState, useLoopbackState } from "../helpers/app-state.js";
import type { ServerMessage } from "../../models/broadcast.js";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { executeTool, reinsTool } from "../helpers/execute-tool.js";

/** Extract text from a TextContent | ImageContent, throwing if not text. */
function textOf(item: TextContent | ImageContent): string {
  if (item.type !== "text") throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}


describe("create_task tool", () => {
  let projectId: number;
  let broadcasts: ServerMessage[];

  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    broadcasts = [];
    // The loopback node's own connection is announced too.
    loopback.state.process.clients.add({ ws: { send: data => { const message = JSON.parse(data); if (message.type !== "node_updated") broadcasts.push(message); return 0; } } });
  });

  describe("tool definition shape", () => {
    test("returns a valid ToolDefinition with required properties", () => {
      const tool = reinsTool("create_task", { projectId, state: loopback.state });

      expect(tool.name).toBe("create_task");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    test("has a label", () => {
      const tool = reinsTool("create_task", { projectId, state: loopback.state });
      expect(tool.label).toBe("Create Task");
    });
  });

  describe("execute — success", () => {
    test("creates a task, whose branch its first session's run makes, and returns it", async () => {
      const tool = reinsTool("create_task", { projectId, state: loopback.state });

      const result = await executeTool(tool, "call-1", {
        title: "Implement dark mode",
        description: "Add dark mode toggle to the settings page",
      }, undefined, undefined);

      // Result has the expected shape
      expect(result.content).toBeArray();
      expect(result.content.length).toBe(1);
      expect(result.content[0].type).toBe("text");
      expect(result.details).not.toBeNull();

      // The text content is parseable JSON with task data
      const taskData = JSON.parse(textOf(result.content[0]));
      expect(taskData.title).toBe("Implement dark mode");
      expect(taskData.description).toBe("Add dark mode toggle to the settings page");
      expect(taskData.branch_name).toStartWith("task/");
      expect(taskData.status).toBe("open");
      expect(taskData.id).toBeGreaterThan(0);

      // Task exists in DB
      const dbTask = getTask(taskData.id);
      expect(dbTask).not.toBeNull();
      expect(dbTask!.title).toBe("Implement dark mode");

      expect(await localGit(repo.dir).branchExists(taskData.branch_name)).toBe(false);

      // Browsers were told
      expect(broadcasts).toEqual([{ type: "task_updated", projectId }]);
    });

    test("uses provided branch_name", async () => {
      const tool = reinsTool("create_task", { projectId, state: loopback.state });

      const result = await executeTool(tool, "call-2", {
        title: "Custom branch",
        description: "Test custom branch name",
        branch_name: "task/my-custom-branch",
      }, undefined, undefined);

      const taskData = JSON.parse(textOf(result.content[0]));
      expect(taskData.branch_name).toBe("task/my-custom-branch");
    });

    test("includes _note when prompt provided but session orchestration is unavailable", async () => {
      const tool = reinsTool("create_task", { projectId, state: loopback.state });

      const result = await executeTool(tool, "call-3", {
        title: "With prompt",
        description: "Test prompt without session",
        prompt: "Start working on this",
      }, undefined, undefined);

      const taskData = JSON.parse(textOf(result.content[0]));
      expect(taskData._note).toContain("not available");
    });

    test("starts an initial task session through the session instance", async () => {
      const started: { taskId: number; prompt: string }[] = [];
      const instance = new SessionInstance(new Models(createAppState()), "caller");
      spyOn(instance, "startTaskSession").mockImplementation(async (taskId, prompt) => {
        started.push({ taskId, prompt });
        return { sessionId: "started-session" };
      });
      const tool = reinsTool("create_task", { projectId, state: loopback.state, instance });

      const result = await executeTool(tool, "call-4", {
        title: "With session",
        description: "Start work immediately",
        prompt: "Implement it",
      });
      await Bun.sleep(0);

      const taskData = JSON.parse(textOf(result.content[0]));
      expect(started).toEqual([{ taskId: taskData.id, prompt: "Implement it" }]);
      expect(taskData._note).toContain("started in background");
    });
  });

  describe("execute — error", () => {
    test("returns error result when the calling session is gone", async () => {
      const tool = reinsTool("create_task", { sessionId: "gone" });

      const result = await executeTool(tool, "call-err-1", {
        title: "Should fail",
        description: "No project",
      }, undefined, undefined);

      expect(textOf(result.content[0])).toStartWith("Error:");
      expect(textOf(result.content[0])).toContain("not found");
      expect(result.details).toBeNull();
    });
  });
});
