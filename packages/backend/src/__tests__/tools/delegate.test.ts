import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { createSession as dbCreateSession } from "../../session-store.js";
import { createDelegateTool, type CreateSessionOpts } from "../../tools/delegate.js";
import { createStrictExtensionContext, createTestManagedSession } from "../helpers/test-pi.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";

const strictCtx = createStrictExtensionContext();

describe("createDelegateTool", () => {
  useTestDb();
  const repo = useTestRepo();

  let projectId: number;
  let taskId: number;
  let parentSessionId: string;
  let deleteSession: ReturnType<typeof mock>;

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    taskId = createTask(projectId, "Test Task", "Task description", "task/test-task").id;
    parentSessionId = "parent-session";
    dbCreateSession(parentSessionId, projectId, {
       agentRuntimeType: "pi",taskId,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });
    deleteSession = mock<(id: string) => void>();
  });

  test("has optional model override parameters", () => {
    const tool = createDelegateTool(parentSessionId, async () => {
      throw new Error("not used");
    }, deleteSession);

    expect(tool.name).toBe("delegate");
    expect(tool.parameters.properties.modelProvider).toBeDefined();
    expect(tool.parameters.properties.modelId).toBeDefined();
    expect(tool.parameters.properties.thinkingLevel).toBeDefined();
  });

  test("inherits the parent session model and thinking level when no override is provided", async () => {
    const captured: CreateSessionOpts[] = [];
    const managed = await createTestManagedSession("child-session");
    managed.session.prompt = async () => {};
    managed.session.dispose = () => {};
    managed.session.abort = async () => {};
    Object.defineProperty(managed.session, "messages", {
      value: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      configurable: true,
    });

    const tool = createDelegateTool(
      parentSessionId,
      async (_projectId, _projectDir, opts) => {
        captured.push(opts ?? {});
        return managed;
      },
      deleteSession,
    );

    const result = await tool.execute("call-1", {
      prompt: "Investigate this",
    }, undefined, undefined, strictCtx);

    expect(result.details).toEqual({ sessionId: "child-session", messageCount: 1 });
    expect(captured).toEqual([
      {
        taskId,
        delegateDepth: 1,
        parentSessionId,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        thinkingLevel: "high",
      },
    ]);
    expect(deleteSession).toHaveBeenCalledWith("child-session");
  });

  test("passes model and thinking overrides when creating the sub-session", async () => {
    const captured: CreateSessionOpts[] = [];
    const managed = await createTestManagedSession("child-session");
    managed.session.prompt = async () => {};
    managed.session.dispose = () => {};
    managed.session.abort = async () => {};
    Object.defineProperty(managed.session, "messages", {
      value: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      configurable: true,
    });

    const tool = createDelegateTool(
      parentSessionId,
      async (_projectId, _projectDir, opts) => {
        captured.push(opts ?? {});
        return managed;
      },
      deleteSession,
    );

    const result = await tool.execute("call-1", {
      prompt: "Investigate this",
      modelProvider: "anthropic",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    }, undefined, undefined, strictCtx);

    expect(result.details).toEqual({ sessionId: "child-session", messageCount: 1 });
    expect(captured).toEqual([
      {
        taskId,
        delegateDepth: 1,
        parentSessionId,
        modelProvider: "anthropic",
        modelId: "claude-haiku-4-5",
        thinkingLevel: "minimal",
      },
    ]);
    expect(deleteSession).toHaveBeenCalledWith("child-session");
  });
});
