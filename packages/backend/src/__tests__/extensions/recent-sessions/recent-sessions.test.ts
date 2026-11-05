import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useTestDb } from "../../helpers/test-db.js";
import { makeRequest } from "../../helpers/request.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { createProject } from "../../project-fixture.js";
import { createSession, updateActivityState } from "../../session-fixture.js";
import { createTask } from "../../../task-store.js";
import { recentSessions, type RecentReads } from "../../../extensions/recent-sessions/index.js";
import type { SessionInfo, TaskInfo } from "@reins/sdk/server";
import { getDb } from "../../../app-globals.js";
import { buildRouter } from "../../../routes/index.js";

const router = buildRouter();
/** A session as the SDK gives it, of task 5 of project 1 unless `taskId` says otherwise. */
const session = (id: string, lastRunStartedAt: string | null, updatedAt: string, taskId: number | null = 5): SessionInfo => ({
  id, source: { id: 1, nodeId: "internal", path: "/tmp/api" }, projectId: 1, taskId, parentSessionId: null, name: id, firstMessage: null, messageCount: 0, model: null,
  background: false, running: false, unread: false, pinned: false, archived: false, startedBy: null, lastRunStartedAt, lastRunId: null, createdAt: updatedAt, updatedAt,
});
const setUpdated = (id: string, at: string) => getDb().query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, id);

describe("the Recent sessions extension", () => {
  useTestDb();
  let state: TestAppState;
  beforeEach(() => { state = createAppState(); });
  afterEach(async () => { await state.nodes.close(); });

  const list = async (limit: number) => {
    const res = (await router.handle(makeRequest("POST", "/api/extensions/recent-sessions/list", { limit }), state))!;
    return { status: res.status, body: await res.json() };
  };

  test("lists the sessions with the latest activity of any project, each with its project, task and activity", async () => {
    const project = createProject("Api", "/tmp/api");
    const task = createTask(project.id, "Dark mode", null, "task/dark-mode");
    createSession("plain", project.id, { agentRuntimeType: "pi" });
    createSession("on-task", project.id, { agentRuntimeType: "pi", taskId: task.id });
    createSession("oldest", project.id, { agentRuntimeType: "pi" });
    getDb().query("UPDATE sessions SET name = 'Review' WHERE id = 'plain'").run();
    setUpdated("oldest", "2026-01-01T00:00:00.000Z");
    setUpdated("plain", "2026-01-02T00:00:00.000Z");
    setUpdated("on-task", "2026-01-03T00:00:00.000Z");
    updateActivityState("plain", "finished");

    expect(await list(2)).toEqual({ status: 200, body: [
      { id: "on-task", name: null, firstMessage: null, project: "Api", task: "Dark mode", updatedAt: "2026-01-03T00:00:00.000Z", activity: null },
      { id: "plain", name: "Review", firstMessage: null, project: "Api", task: null, updatedAt: "2026-01-02T00:00:00.000Z", activity: "unread" },
    ] });
  });

  test("refuses a limit out of range", async () => {
    expect((await list(0)).status).toBe(400);
  });

  test("leaves out a closed task's sessions until a run starts in one after the task closed, not one going as it closed", async () => {
    const closedAt = "2026-01-03T00:00:00.000Z";
    const sessions = [
      session("closed-itself", "2026-01-02T23:59:00.000Z", "2026-01-03T00:01:00.000Z"),
      session("started-after", "2026-01-04T00:00:00.000Z", "2026-01-04T00:05:00.000Z"),
      session("never-ran", null, "2026-01-02T00:00:00.000Z"),
      session("no-task", null, "2026-01-01T00:00:00.000Z", null),
    ];
    const task: TaskInfo = {
      id: 5, projectId: 1, title: "Ship it", description: null, branchName: "task/ship-it", baseCommit: null, status: "closed", closedAt, createdAt: closedAt, updatedAt: closedAt,
    };
    const reads: RecentReads = {
      sessions: { list: async ({ offset = 0 } = {}) => offset === 0 ? sessions : [] },
      projects: { get: async () => ({ id: 1, name: "Api", baseBranch: "main", defaultSourceId: 1, createdAt: closedAt, lastOpenedAt: closedAt }) },
      tasks: { get: async () => task },
    };

    expect((await recentSessions(reads, 8)).map(({ id }) => id)).toEqual(["started-after", "no-task"]);
  });
});
