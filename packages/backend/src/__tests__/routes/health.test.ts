import { describe, test, expect } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createAppState, stubRuntime } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { connectScriptedNode } from "../helpers/loopback-node.js";
import { getDb } from "../../injected-process-state.js";

describe("GET /api/health", () => {
  useTestDb();

  test("returns 200 with status ok", async () => {
    const router = buildRouter();
    const state = createAppState();
    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.activeSessions).toBe(0);
    expect(body.streaming).toBe(false);
  });

  test("reports running sessions", async () => {
    const router = buildRouter();
    const project = createProject("Health", "/tmp/health-active");
    createSession("running", project.id, { agentRuntimeType: "pi" });
    createSession("idle", project.id, { agentRuntimeType: "pi" });
    const state = createAppState();
    stubRuntime(state.process, "running");
    stubRuntime(state.process, "idle", { busy: () => false });

    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    const body = await res!.json();
    expect(body.activeSessions).toBe(1);
    expect(body.streaming).toBe(true);
  });

  test("lists every node with whether it is connected", async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const state = createAppState();
    const health = async () => (await (await buildRouter().handle(makeRequest("GET", "/api/health"), state))!.json()).nodes;
    expect(await health()).toEqual([{ id: "internal", name: "Internal", connected: false }, { id: "remote", name: "Remote", connected: false }]);
    await connectScriptedNode(state, "remote", {}).ready();
    expect(await health()).toEqual([{ id: "internal", name: "Internal", connected: false }, { id: "remote", name: "Remote", connected: true }]);
  });
});
