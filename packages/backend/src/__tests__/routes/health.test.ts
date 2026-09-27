import { describe, test, expect } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../../project-store.js";
import { updateActivityState } from "../../session-store.js";
import { createProvisionedNodeSession, queuePrompt } from "../helpers/node-session.js";

describe("GET /api/health", () => {
  useTestDb();

  test("returns 200 with status ok", async () => {
    const router = buildRouter();
    const state = createServerState();
    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.activeSessions).toBe(0);
    expect(body.streaming).toBe(false);
  });

  test("reports sessions active on their node: running, or with queued input", async () => {
    const router = buildRouter();
    const project = createProject("Health", "/tmp/health-active");
    createProvisionedNodeSession("running", project.id);
    updateActivityState("running", "running");
    createProvisionedNodeSession("queued", project.id);
    queuePrompt("queued", "client-1");
    createProvisionedNodeSession("idle", project.id);
    const state = createServerState();

    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    const body = await res!.json();
    expect(body.activeSessions).toBe(2);
    expect(body.streaming).toBe(true);
  });
});
