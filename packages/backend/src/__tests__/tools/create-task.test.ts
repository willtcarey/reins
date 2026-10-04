import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createProject } from "../../project-store.js";
import { getTask } from "../../task-store.js";
import { createSource } from "../../node-store.js";
import { getDb } from "../../db.js";
import { Git } from "../../git.js";
import { SessionInstance } from "../../sessions/session-instance.js";
import { createServerState, useLoopbackState } from "../helpers/server-state.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { executeTool, reinsTool } from "../helpers/execute-tool.js";

/** Extract text from a TextContent | ImageContent, throwing if not text. */
function textOf(item: TextContent | ImageContent): string {
  if (item.type !== "text") throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}


describe("create_task tool", () => {
  let projectId: number;
  let broadcastSpy: ReturnType<typeof mock>;
  let broadcast: Broadcast;

  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    broadcast = broadcastSpy;
  });

  describe("tool definition shape", () => {
    test("returns a valid ToolDefinition with required properties", () => {
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes });

      expect(tool.name).toBe("create_task");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    test("has a label", () => {
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes });
      expect(tool.label).toBe("Create Task");
    });
  });

  describe("execute — success", () => {
    test("creates a task and branch, returns success result", async () => {
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes });

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

      // Branch exists in git
      expect(await Git.local(repo.dir).branchExists(taskData.branch_name)).toBe(true);

      // Broadcast was called
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });

    test("uses provided branch_name", async () => {
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes });

      const result = await executeTool(tool, "call-2", {
        title: "Custom branch",
        description: "Test custom branch name",
        branch_name: "task/my-custom-branch",
      }, undefined, undefined);

      const taskData = JSON.parse(textOf(result.content[0]));
      expect(taskData.branch_name).toBe("task/my-custom-branch");
    });

    test("includes _note when prompt provided but session orchestration is unavailable", async () => {
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes });

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
      const instance = new SessionInstance(createServerState(), "caller");
      spyOn(instance, "startTaskSession").mockImplementation(async (taskId, prompt) => {
        started.push({ taskId, prompt });
        return { sessionId: "started-session" };
      });
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes, instance });

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
    test("returns error result when project not found", async () => {
      const tool = reinsTool("create_task", { projectId: 99999, broadcast });

      const result = await executeTool(tool, "call-err-1", {
        title: "Should fail",
        description: "No project",
      }, undefined, undefined);

      expect(textOf(result.content[0])).toStartWith("Error:");
      expect(textOf(result.content[0])).toContain("not found");
      expect(result.details).toBeNull();
    });

    test("creates the branch in the calling session's source, not the project's default", async () => {
      getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
      const remote = createSource(projectId, "remote", "/remote/checkout");
      const tool = reinsTool("create_task", { projectId, broadcast, nodes: loopback.state.nodes, sourceId: remote.id });

      const result = await executeTool(tool, "call-err-source", { title: "Elsewhere", description: "" }, undefined, undefined);

      // The session's node is not connected (the default source's is).
      expect(textOf(result.content[0])).toBe("Error: Node not connected");
      expect(await Git.local(repo.dir).branchExists("task/elsewhere")).toBe(false);
    });

    test("returns error result on git failure", async () => {
      // Create tool pointing to a project with a bad path
      const badProject = createProject("Bad Project", "/nonexistent/path", "main");
      const tool = reinsTool("create_task", { projectId: badProject.id, broadcast });

      const result = await executeTool(tool, "call-err-2", {
        title: "Should fail",
        description: "Bad git path",
      }, undefined, undefined);

      expect(textOf(result.content[0])).toStartWith("Error:");
      expect(result.details).toBeNull();
    });
  });
});
