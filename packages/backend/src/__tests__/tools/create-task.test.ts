import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createProject } from "../../project-store.js";
import { getTask } from "../../task-store.js";
import { branchExists } from "../../git.js";
import { createTaskTool, type CreateTaskToolOpts } from "../../tools/create-task.js";
import type { Broadcast } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";

describe("createTaskTool", () => {
  let projectId: number;
  let broadcastSpy: ReturnType<typeof mock>;
  let broadcast: Broadcast;
  let sessions: Map<string, ManagedSession>;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    broadcastSpy = mock();
    broadcast = broadcastSpy as unknown as Broadcast;
    sessions = new Map();
  });

  describe("tool definition shape", () => {
    test("returns a valid ToolDefinition with required properties", () => {
      const tool = createTaskTool({ projectId, broadcast, sessions });

      expect(tool.name).toBe("create_task");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    test("has a label", () => {
      const tool = createTaskTool({ projectId, broadcast, sessions });
      expect(tool.label).toBe("Create Task");
    });
  });

  describe("execute — success", () => {
    test("creates a task and branch, returns success result", async () => {
      const tool = createTaskTool({ projectId, broadcast, sessions });

      const result = await tool.execute("call-1", {
        title: "Implement dark mode",
        description: "Add dark mode toggle to the settings page",
      });

      // Result has the expected shape
      expect(result.content).toBeArray();
      expect(result.content.length).toBe(1);
      expect(result.content[0].type).toBe("text");
      expect(result.details).not.toBeNull();

      // The text content is parseable JSON with task data
      const taskData = JSON.parse(result.content[0].text);
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
      expect(await branchExists(repo.dir, taskData.branch_name)).toBe(true);

      // Broadcast was called
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });

    test("uses provided branch_name", async () => {
      const tool = createTaskTool({ projectId, broadcast, sessions });

      const result = await tool.execute("call-2", {
        title: "Custom branch",
        description: "Test custom branch name",
        branch_name: "task/my-custom-branch",
      });

      const taskData = JSON.parse(result.content[0].text);
      expect(taskData.branch_name).toBe("task/my-custom-branch");
    });

    test("includes _note when prompt provided but no createSession", async () => {
      const tool = createTaskTool({ projectId, broadcast, sessions });

      const result = await tool.execute("call-3", {
        title: "With prompt",
        description: "Test prompt without session",
        prompt: "Start working on this",
      });

      const taskData = JSON.parse(result.content[0].text);
      expect(taskData._note).toContain("not available");
    });
  });

  describe("execute — error", () => {
    test("returns error result when project not found", async () => {
      const tool = createTaskTool({ projectId: 99999, broadcast, sessions });

      const result = await tool.execute("call-err-1", {
        title: "Should fail",
        description: "No project",
      });

      expect(result.content[0].text).toStartWith("Error:");
      expect(result.content[0].text).toContain("not found");
      expect(result.details).toBeNull();
    });

    test("returns error result on git failure", async () => {
      // Create tool pointing to a project with a bad path
      const badProject = createProject("Bad Project", "/nonexistent/path", "main");
      const tool = createTaskTool({ projectId: badProject.id, broadcast, sessions });

      const result = await tool.execute("call-err-2", {
        title: "Should fail",
        description: "Bad git path",
      });

      expect(result.content[0].text).toStartWith("Error:");
      expect(result.details).toBeNull();
    });
  });
});
