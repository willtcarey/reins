import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { localGit } from "../helpers/local-git.js";
import { stubRuntime, useLoopbackState } from "../helpers/app-state.js";
import { createProject } from "../project-fixture.js";
import { createTask, getTask } from "../../task-store.js";
import { createSession, getSession, updateActivityState } from "../session-fixture.js";
import { ProjectModel } from "../../models/projects.js";
import { Nodes } from "../../models/nodes.js";
import type { CreateTaskParams } from "../../models/tasks.js";
import { openSessionRuntime } from "../../session-runtime/live.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";

describe("ProjectTasks", () => {
  let projectId: number;
  let broadcastSpy: ReturnType<typeof mock<(msg: ServerMessage) => void>>;
  let broadcast: Broadcast;
  let model: ProjectModel;

  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    broadcast = broadcastSpy;
    model = new ProjectModel(projectId, new Nodes(loopback.state, broadcast));
  });

  test("creates the task's row, and no branch: its sessions' runs make it where they work", async () => {
    const params: CreateTaskParams = {
      title: "Add login page",
      description: "Build the login UI",
    };

    const task = await model.tasks().create(params);

    // DB row exists and has correct fields
    expect(task.id).toBeGreaterThan(0);
    expect(task.project_id).toBe(projectId);
    expect(task.title).toBe("Add login page");
    expect(task.description).toBe("Build the login UI");
    expect(task.status).toBe("open");
    expect(task.branch_name).toStartWith("task/");
    expect(task.base_commit).toBeNull();
    expect(task.created_at).toBeTruthy();
    expect(task.updated_at).toBeTruthy();

    expect(await localGit(repo.dir).branchExists(task.branch_name)).toBe(false);

    // DB row matches what getTask returns
    const fetched = getTask(task.id);
    expect(fetched).toEqual(task);
  });

  test("derives branch name from title when not provided", async () => {
    const task = await model.tasks().create({ title: "Fix broken tests", description: "" });

    expect(task.branch_name).toBe("task/fix-broken-tests");
  });

  test("uses provided branch name when given", async () => {
    const task = await model.tasks().create({ title: "Some task", description: "", branch_name: "task/custom-name" });

    expect(task.branch_name).toBe("task/custom-name");
  });

  test("a branch name derived from the title that another of the project's tasks has gets a suffix; one given is kept", async () => {
    await model.tasks().create({ title: "My Feature", description: "" });

    const derived = await model.tasks().create({ title: "My Feature", description: "" });
    const given = await model.tasks().create({ title: "Again", description: "", branch_name: "task/my-feature" });

    expect(derived.branch_name).toStartWith("task/my-feature-");
    expect(given.branch_name).toBe("task/my-feature");
  });

  test("calls broadcast with task_updated", async () => {
    await model.tasks().create({ title: "Broadcast test", description: "" });

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "task_updated",
      projectId,
    });
  });

  test("trims title and description", async () => {
    const task = await model.tasks().create({ title: "  Trimmed Title  ", description: "  Trimmed Desc  " });

    expect(task.title).toBe("Trimmed Title");
    expect(task.description).toBe("Trimmed Desc");
  });

  test("closing a task clears finished session activity but preserves running activity", () => {
    const task = createTask(projectId, "Close me", null, "task/close-me");
    createSession("finished-session", projectId, { agentRuntimeType: "pi", taskId: task.id });
    createSession("running-session", projectId, { agentRuntimeType: "pi", taskId: task.id });
    updateActivityState("finished-session", "finished");
    stubRuntime(loopback.state.process, "running-session");

    model.tasks().close(task.id);

    expect(getSession("finished-session")!.activity_state).toBeNull();
    expect(getSession("running-session")!.activity_state).toBe("running");
    expect(broadcastSpy).toHaveBeenCalledWith({ type: "task_updated", projectId });
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "session_updated",
      sessionId: "finished-session",
      projectId,
    });
  });

  test("does not delete a task while one of its sessions is running", async () => {
    const task = createTask(projectId, "Running", null, "task/node-running");
    createSession("node-active", projectId, { agentRuntimeType: "pi", taskId: task.id });
    stubRuntime(loopback.state.process, "node-active");

    await expect(model.tasks().delete(task.id, loopback.state.process)).rejects.toThrow("currently running");
    expect(getTask(task.id)).not.toBeNull();
    expect(getSession("node-active")!.activity_state).toBe("running");
  });

  test("deleting a task closes its sessions' live runtimes before their rows go", async () => {
    const task = createTask(projectId, "Deleted", null, "task/deleted");
    createSession("idle-session", projectId, { agentRuntimeType: "pi", taskId: task.id, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
    const runtime = await openSessionRuntime(loopback.state.process, "idle-session");
    const rowAtClose: unknown[] = [];
    spyOn(runtime, "close").mockImplementation(async () => { rowAtClose.push(getSession("idle-session")?.id); });

    await model.tasks().delete(task.id, loopback.state.process);
    expect(rowAtClose).toEqual(["idle-session"]);
    expect(loopback.state.process.sessions.live.has("idle-session")).toBe(false);
    expect(getSession("idle-session")).toBeNull();
  });
});
