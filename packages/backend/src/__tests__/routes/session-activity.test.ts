import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession, updateActivityState } from "../../session-store.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

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

  test("transitions 'finished' to NULL and returns ok", async () => {
    const sessionId = "sess-viewed";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });
    updateActivityState(sessionId, "finished");

    const res = await router.handle(
      makeRequest("PATCH", `/api/sessions/${sessionId}/activity`),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ ok: true });
    expect(getSession(sessionId)!.activity_state).toBeNull();
  });

  test("returns 404 for nonexistent session", async () => {
    const res = await router.handle(
      makeRequest("PATCH", "/api/sessions/nonexistent/activity"),
      state,
    );

    expect(res!.status).toBe(404);
  });

  test("no-ops when activity_state is not 'finished'", async () => {
    const sessionId = "sess-running";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });
    updateActivityState(sessionId, "running");

    const res = await router.handle(
      makeRequest("PATCH", `/api/sessions/${sessionId}/activity`),
      state,
    );

    // Should still return ok even though no transition happened
    expect(res!.status).toBe(200);
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
    const stub = createRuntimeStub({ isStreaming: true });
    state.sessions.set("s-running", { id: "s-running", runtime: stub.runtime, lastActivity: 0 });

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
    expect(body).toContainEqual({ id: "s-running", activityState: "running", projectId });
    expect(body).toContainEqual({ id: "s-finished", activityState: "finished", projectId });
    expect(body[0]).not.toHaveProperty("activity_state");
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

  test("reconciles persisted running sessions without a streaming runtime to finished", async () => {
    createSession("s-stale", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-stale", "running");

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual([{ id: "s-stale", activityState: "finished", projectId }]);
    expect(getSession("s-stale")!.activity_state).toBe("finished");
  });

  test("keeps persisted running sessions running when their runtime is streaming", async () => {
    createSession("s-streaming", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-streaming", "running");
    const stub = createRuntimeStub({ isStreaming: true });
    state.sessions.set("s-streaming", { id: "s-streaming", runtime: stub.runtime, lastActivity: 0 });

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual([{ id: "s-streaming", activityState: "running", projectId }]);
    expect(getSession("s-streaming")!.activity_state).toBe("running");
  });

  test("includes sessions across multiple projects", async () => {
    createSession("s-a", projectId, { agentRuntimeType: "pi" });
    updateActivityState("s-a", "running");
    const stub = createRuntimeStub({ isStreaming: true });
    state.sessions.set("s-a", { id: "s-a", runtime: stub.runtime, lastActivity: 0 });

    createSession("s-b", projectId2, { agentRuntimeType: "pi" });
    updateActivityState("s-b", "finished");

    const res = await router.handle(
      makeRequest("GET", "/api/sessions/activity"),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toHaveLength(2);
    expect(body).toContainEqual({ id: "s-a", activityState: "running", projectId });
    expect(body).toContainEqual({ id: "s-b", activityState: "finished", projectId: projectId2 });
  });
});
