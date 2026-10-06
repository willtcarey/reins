import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession, updateActivityState } from "../session-fixture.js";
import { createTask, setTaskStatus } from "../../task-store.js";

describe("PATCH /api/sessions/:sessionId/activity", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    const p = createProject("Test Project", "/tmp/test-activity-route");
    projectId = p.id;
  });

  test("marks a finished session read", async () => {
    const sessionId = "sess-viewed";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });
    updateActivityState(sessionId, "finished");

    const res = await router.handle(
      makeRequest("PATCH", `/api/sessions/${sessionId}/activity`, { unread: false }),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ ok: true });
    expect(getSession(sessionId)!.activity_state).toBeNull();
  });

  test("marks an idle session unread", async () => {
    const sessionId = "sess-unread";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });

    const res = await router.handle(
      makeRequest("PATCH", `/api/sessions/${sessionId}/activity`, { unread: true }),
      state,
    );

    expect(res!.status).toBe(200);
    expect(getSession(sessionId)!.activity_state).toBe("finished");
  });

  test("returns 404 for nonexistent session", async () => {
    const res = await router.handle(
      makeRequest("PATCH", "/api/sessions/nonexistent/activity", { unread: false }),
      state,
    );

    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "Session not found" });
  });

  test("does not mark a running session unread", async () => {
    const sessionId = "sess-running";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });
    updateActivityState(sessionId, "running");

    const res = await router.handle(
      makeRequest("PATCH", `/api/sessions/${sessionId}/activity`, { unread: true }),
      state,
    );

    expect(res!.status).toBe(400);
    expect(getSession(sessionId)!.activity_state).toBe("running");
  });
});

describe("GET /api/sessions/activity", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;
  let projectId2: number;

  useTestDb();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    const p = createProject("Project A", "/tmp/test-activity-a");
    projectId = p.id;
    const p2 = createProject("Project B", "/tmp/test-activity-b");
    projectId2 = p2.id;
  });

  test("returns sessions with non-null activityState", async () => {
    createSession("s-running", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-running", "running");

    createSession("s-finished", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-finished", "finished");

    createSession("s-none", projectId, { agentRuntimeType: "pi" });
    // no activity state set — should not appear

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toHaveLength(2);
    expect(body).toContainEqual({ id: "s-running", activityState: "running", projectId, taskId: null });
    expect(body).toContainEqual({ id: "s-finished", activityState: "finished", projectId, taskId: null });
    expect(body[0]).not.toHaveProperty("activity_state");
  });

  test("includes taskId for task sessions", async () => {
    const task = createTask(projectId, "Task", null, "task/activity");
    createSession("s-task", projectId, { agentRuntimeType: "pi", taskId: task.id });
    updateActivityState("s-task", "finished");

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual([{ id: "s-task", activityState: "finished", projectId, taskId: task.id }]);
  });

  test("includes unread sessions on closed tasks, which only a session resumed after the close has", async () => {
    const task = createTask(projectId, "Closed task", null, "task/closed-activity");
    setTaskStatus(task.id, "closed");
    createSession("s-closed", projectId, { agentRuntimeType: "pi", taskId: task.id });
    updateActivityState("s-closed", "finished");

    const res = await router.handle(makeRequest("GET", "/api/sessions/activity"), state);

    expect(await res!.json()).toEqual([{ id: "s-closed", activityState: "finished", projectId, taskId: task.id }]);
  });

  test("excludes background sessions from the activity snapshot", async () => {
    createSession("s-visible", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-visible", "finished");
    createSession("s-background", projectId, { agentRuntimeType: "pi", background: true });
    updateActivityState("s-background", "running");

    const res = await router.handle(makeRequest("GET", "/api/sessions/activity"), state);

    expect(await res!.json()).toEqual([{ id: "s-visible", activityState: "finished", projectId, taskId: null }]);
  });

  test("returns empty array when no active sessions", async () => {
    createSession("s-none", projectId, { agentRuntimeType: "pi" });

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual([]);
  });

  test("keeps a running session on its node running (its node reports its activity)", async () => {
    createSession("s-streaming", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-streaming", "running");

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual([{ id: "s-streaming", activityState: "running", projectId, taskId: null }]);
    expect(getSession("s-streaming")!.activity_state).toBe("running");
  });

  test("includes sessions across multiple projects", async () => {
    createSession("s-a", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-a", "running");

    createSession("s-b", projectId2, { agentRuntimeType: "pi" });
    updateActivityState("s-b", "finished");

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toHaveLength(2);
    expect(body).toContainEqual({ id: "s-a", activityState: "running", projectId, taskId: null });
    expect(body).toContainEqual({ id: "s-b", activityState: "finished", projectId: projectId2, taskId: null });
  });
});
