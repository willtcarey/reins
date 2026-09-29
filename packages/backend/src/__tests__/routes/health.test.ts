import { describe, test, expect } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../../project-store.js";
import { updateActivityState } from "../../session-store.js";
import { createNodeSession, queuePrompt } from "../helpers/node-session.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { getDb } from "../../db.js";

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
    createNodeSession("running", project.id);
    updateActivityState("running", "running");
    createNodeSession("queued", project.id);
    queuePrompt("queued", "client-1");
    createNodeSession("idle", project.id);
    const state = createServerState();

    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    const body = await res!.json();
    expect(body.activeSessions).toBe(2);
    expect(body.streaming).toBe(true);
  });

  test("lists every node with whether it is connected", async () => {
    getDb().exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
    const state = createServerState();
    const health = async () => (await (await buildRouter().handle(makeRequest("GET", "/api/health"), state))!.json()).nodes;
    expect(await health()).toEqual([{ id: "internal", name: "Internal", connected: false }, { id: "remote", name: "Remote", connected: false }]);
    await useFakeNode(state, "remote").link.ready();
    expect(await health()).toEqual([{ id: "internal", name: "Internal", connected: false }, { id: "remote", name: "Remote", connected: true }]);
  });
});
