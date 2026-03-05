import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { createProject } from "../../project-store.js";
import { getTask } from "../../task-store.js";
import { branchExists, getCurrentBranch, revParse, mergeBase, createBranch } from "../../git.js";
import { ProjectTasks, type CreateTaskParams } from "../../models/tasks.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";

describe("createTaskWithBranch", () => {
  let projectId: number;
  let broadcastSpy: ReturnType<typeof mock>;
  let broadcast: Broadcast;
  let sessions: Map<string, ManagedSession>;
  let tasks: ProjectTasks;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    broadcastSpy = mock();
    broadcast = broadcastSpy as unknown as Broadcast;
    sessions = new Map();
    tasks = new ProjectTasks(projectId, repo.dir, "main", sessions, broadcast);
  });

  test("creates a git branch and a DB row", async () => {
    const params: CreateTaskParams = {
      title: "Add login page",
      description: "Build the login UI",
    };

    const task = await tasks.create(params);

    // DB row exists and has correct fields
    expect(task.id).toBeGreaterThan(0);
    expect(task.project_id).toBe(projectId);
    expect(task.title).toBe("Add login page");
    expect(task.description).toBe("Build the login UI");
    expect(task.status).toBe("open");
    expect(task.branch_name).toStartWith("task/");
    expect(task.base_commit).toBeTruthy();
    expect(task.created_at).toBeTruthy();
    expect(task.updated_at).toBeTruthy();

    // Git branch exists
    expect(await branchExists(repo.dir, task.branch_name)).toBe(true);

    // DB row matches what getTask returns
    const fetched = getTask(task.id);
    expect(fetched).toEqual(task);
  });

  test("derives branch name from title when not provided", async () => {
    const task = await tasks.create({ title: "Fix broken tests", description: "" });

    expect(task.branch_name).toBe("task/fix-broken-tests");
  });

  test("uses provided branch name when given", async () => {
    const task = await tasks.create({ title: "Some task", description: "", branch_name: "task/custom-name" });

    expect(task.branch_name).toBe("task/custom-name");
  });

  test("appends suffix on branch collision", async () => {
    // Create the first task to occupy the branch name
    await tasks.create({ title: "My Feature", description: "" });

    // Create a second task with the same title — should get a suffixed branch
    const task2 = await tasks.create({ title: "My Feature", description: "" });

    expect(task2.branch_name).toStartWith("task/my-feature-");
    expect(task2.branch_name).not.toBe("task/my-feature");
    expect(await branchExists(repo.dir, task2.branch_name)).toBe(true);
  });

  test("captures base commit SHA", async () => {
    const expectedSha = await revParse(repo.dir, "main");

    const task = await tasks.create({ title: "Capture SHA", description: "" });

    expect(task.base_commit).toBe(expectedSha);
  });

  test("calls broadcast with task_updated", async () => {
    await tasks.create({ title: "Broadcast test", description: "" });

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "task_updated",
      projectId,
    });
  });

  test("throws on git failure and does not create DB row", async () => {
    const badTasks = new ProjectTasks(projectId, repo.dir, "nonexistent-branch", sessions, broadcast);

    await expect(
      badTasks.create({ title: "Should fail", description: "" }),
    ).rejects.toThrow();

    // Broadcast should not have been called
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  test("trims title and description", async () => {
    const task = await tasks.create({ title: "  Trimmed Title  ", description: "  Trimmed Desc  " });

    expect(task.title).toBe("Trimmed Title");
    expect(task.description).toBe("Trimmed Desc");
  });

  test("adopts an existing local branch when branch_name is explicitly provided", async () => {
    // Create a branch manually from main
    await createBranch(repo.dir, "task/existing", "main");

    // Advance main so merge-base differs from main tip
    await commitFile(repo.dir, "advance.txt", "advance", "advance main");
    // (commitFile commits on the current branch which is main)

    const mainTip = await revParse(repo.dir, "main");
    const expectedBase = await mergeBase(repo.dir, "main", "task/existing");

    // merge-base should differ from main tip (main advanced past the branch point)
    expect(expectedBase).not.toBe(mainTip);

    const task = await tasks.create({
      title: "Adopt me",
      description: "",
      branch_name: "task/existing",
    });

    // Should adopt the branch as-is, no suffix
    expect(task.branch_name).toBe("task/existing");
    // base_commit should be the merge-base, not the current main tip
    expect(task.base_commit).toBe(expectedBase);
  });
});

describe("createTaskWithBranch — remote adoption", () => {
  let projectId: number;
  let broadcastSpy: ReturnType<typeof mock>;
  let broadcast: Broadcast;
  let sessions: Map<string, ManagedSession>;
  let tasks: ProjectTasks;

  useTestDb();
  const repo = useTestRepo({ withRemote: true });

  beforeEach(() => {
    const project = createProject("Test Project", repo.dir, "main");
    projectId = project.id;
    broadcastSpy = mock();
    broadcast = broadcastSpy as unknown as Broadcast;
    sessions = new Map();
    tasks = new ProjectTasks(projectId, repo.dir, "main", sessions, broadcast);
  });

  test("adopts a remote-only branch when branch_name is explicitly provided", async () => {
    // Create a separate clone, create a branch there, push it to origin
    const cloneDir = `${repo.dir}-clone`;
    const proc = Bun.spawn(["git", "clone", repo.remoteDir, cloneDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Configure the clone and create a branch with a commit
    await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: cloneDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: cloneDir, stdout: "pipe", stderr: "pipe" }).exited;
    await commitFile(cloneDir, "remote-work.txt", "work", "work on remote branch");
    await createBranch(cloneDir, "task/remote-only", "main");
    // Push the branch to origin
    await Bun.spawn(["git", "push", "origin", "task/remote-only"], { cwd: cloneDir, stdout: "pipe", stderr: "pipe" }).exited;

    // Advance main in the original repo so merge-base differs
    await commitFile(repo.dir, "local-advance.txt", "local", "advance local main");

    // Fetch so our repo knows about origin's branches
    await Bun.spawn(["git", "fetch", "origin"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" }).exited;

    // Verify branch does NOT exist locally but DOES exist on remote
    expect(await branchExists(repo.dir, "task/remote-only")).toBe(false);

    const task = await tasks.create({
      title: "Remote adopt",
      description: "",
      branch_name: "task/remote-only",
    });

    // Local branch should now exist (created as tracking branch)
    expect(await branchExists(repo.dir, "task/remote-only")).toBe(true);
    expect(task.branch_name).toBe("task/remote-only");

    // base_commit should be merge-base, not main tip
    const mainTip = await revParse(repo.dir, "main");
    const expectedBase = await mergeBase(repo.dir, "main", "task/remote-only");
    expect(task.base_commit).toBe(expectedBase);
    expect(task.base_commit).not.toBe(mainTip);

    // Cleanup clone
    const { rmSync } = await import("fs");
    rmSync(cloneDir, { recursive: true, force: true });
  });
});
