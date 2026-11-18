import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { useTestDb } from "../../helpers/test-db.js";
import { git, useTestRepo } from "../../helpers/test-repo.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode } from "../../helpers/loopback-node.js";
import { useFakeModel } from "../../helpers/fake-model.js";
import { until } from "../../helpers/session-host.js";
import { createProject } from "../../project-fixture.js";
import { createTask, getTask, setTaskStatus, updateTask } from "../../../task-store.js";
import { latestSettlement } from "../../../sessions/session-runs.js";
import { createSession } from "../../../sessions/create-session.js";
import { openSessionRuntime } from "../../../session-runtime/live.js";

setDefaultTimeout(20_000);

describe("a task's own branch, before each run of its sessions", () => {
  useTestDb();
  const repo = useTestRepo();
  const model = useFakeModel();
  let state: TestAppState;

  const start = async () => {
    state = createAppState(undefined, { loopbackNode: true, extensions: [] });
    await loopbackLink(state).ready();
  };
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
  });

  const head = () => git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

  /** Runs one prompt of a new session of the task to its end (the model answers at once). */
  const run = async (projectId: number, taskId: number) => {
    const sessionId = createSession(state, { projectId, taskId, model: model.model }).id;
    const runtime = await openSessionRuntime(state.process, sessionId);
    await runtime.prompt([{ type: "text", text: "Hello" }], { reinsId: crypto.randomUUID() });
    const asked = () => model.turns.filter(turn => turn.sessionId === sessionId);
    await until(() => latestSettlement(sessionId) !== null || asked().length > 0, "the run's model request or end");
    for (const turn of asked()) turn.finish();
    await until(() => latestSettlement(sessionId) !== null, "the run's end");
    return sessionId;
  };

  beforeEach(start);

  test("leaves a task without a branch of its own on what is checked out; its task records where it started", async () => {
    const project = createProject("Branchless", repo.dir);
    const task = createTask(project.id, "Branchless", null, null);
    const main = await git(repo.dir, ["rev-parse", "HEAD"]);

    await run(project.id, task.id);

    expect(await head()).toBe("main");
    expect(getTask(task.id)).toMatchObject({ branch_name: null, start_branch: "main", base_commit: main });
  });

  test("for a task with a branch of its own, makes the task's branch from the base branch, checks it out and records it on the task", async () => {
    const project = createProject("On", repo.dir);
    const task = createTask(project.id, "New", null, "task/new-here");
    const base = await git(repo.dir, ["rev-parse", "main"]);

    const sessionId = await run(project.id, task.id);

    expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
    expect(await head()).toBe("task/new-here");
    expect(await git(repo.dir, ["rev-parse", "task/new-here"])).toBe(base);
    expect(getTask(task.id)).toMatchObject({ branch_name: "task/new-here", base_commit: base, start_branch: "task/new-here" });
  });

  test("checks out a task's branch that exists, and leaves a session of no task where it is", async () => {
    await git(repo.dir, ["branch", "task/existing"]);
    const project = createProject("On", repo.dir);
    const task = createTask(project.id, "Existing", null, "task/existing");

    await run(project.id, task.id);
    expect(await head()).toBe("task/existing");

    await git(repo.dir, ["checkout", "main"]);
    const scratch = createSession(state, { projectId: project.id, model: model.model }).id;
    await (await openSessionRuntime(state.process, scratch)).prompt([{ type: "text", text: "Hello" }], { reinsId: "scratch" });
    (await model.nextTurn(scratch)).finish();
    await until(() => latestSettlement(scratch) !== null, "the scratch run's end");
    expect(await head()).toBe("main");
  });

  test("does nothing for a closed task: its sessions run on what is checked out, and its deleted branch is not made again", async () => {
    const project = createProject("On", repo.dir);
    const task = createTask(project.id, "Done", null, "task/done");
    updateTask(task.id, { base_commit: await git(repo.dir, ["rev-parse", "main"]) });
    setTaskStatus(task.id, "closed");

    const sessionId = await run(project.id, task.id);

    expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
    expect(await head()).toBe("main");
    expect(await git(repo.dir, ["branch", "--list", "task/done"])).toBe("");
  });

  test("refuses the run of an open task whose branch was deleted, rather than make a new one, without asking the model", async () => {
    const project = createProject("On", repo.dir);
    const task = createTask(project.id, "Gone", null, "task/gone");
    updateTask(task.id, { base_commit: await git(repo.dir, ["rev-parse", "main"]) });

    const sessionId = await run(project.id, task.id);

    expect(latestSettlement(sessionId)).toMatchObject({
      status: "failed",
      error: { code: "branch_deleted", message: "This task's branch, task/gone, was deleted. Make it again, or close the task." },
    });
    expect(model.turns).toHaveLength(0);
    expect(await head()).toBe("main");
  });

  test("two runs of a task starting at once make its branch once: both run on it", async () => {
    const project = createProject("On", repo.dir);
    const task = createTask(project.id, "Together", null, "task/together");
    const sessions = [0, 1].map(() => createSession(state, { projectId: project.id, taskId: task.id, model: model.model }).id);

    for (const sessionId of sessions) await (await openSessionRuntime(state.process, sessionId)).prompt([{ type: "text", text: "Hello" }], { reinsId: crypto.randomUUID() });
    for (const sessionId of sessions) (await model.nextTurn(sessionId)).finish();
    await until(() => sessions.every(sessionId => latestSettlement(sessionId) !== null), "both runs' ends");

    for (const sessionId of sessions) expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
    expect(await head()).toBe("task/together");
  });

  test("a git failure fails the run, without asking the model", async () => {
    const project = createProject("Missing base", repo.dir, "no-such-base");
    const task = createTask(project.id, "Missing", null, "task/missing");

    const sessionId = await run(project.id, task.id);

    expect(latestSettlement(sessionId)).toMatchObject({ status: "failed", error: { message: expect.stringContaining("Preparing the checkout failed") } });
    expect(model.turns).toHaveLength(0);
  });
});
