import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState, useLoopbackState } from "../helpers/server-state.js";
import { connectLoopbackNode, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { defaultSource } from "../../node-store.js";
import { listProjects } from "../../project-store.js";
import { getDb } from "../../db.js";
import { createTestRepo, git } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { getSession } from "../../session-store.js";
import { createSession } from "../session-fixture.js";
import { useFakeNode } from "../helpers/fake-node.js";

describe("project routes", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let tempDir: string;

  useTestDb();
  const loopback = useLoopbackState();

  beforeEach(() => {
    state = loopback.state;
    router = buildRouter();
    tempDir = mkdtempSync(join(tmpdir(), "reins-test-projects-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("GET /api/projects", () => {
    test("returns empty list when no projects", async () => {
      const res = await router.handle(makeRequest("GET", "/api/projects"), state);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns all created projects", async () => {
      createProject("First", tempDir);
      const res = await router.handle(makeRequest("GET", "/api/projects"), state);
      const body = await res!.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("First");
    });
  });

  describe("POST /api/projects", () => {
    const create = (body: Record<string, unknown>, on = state) => router.handle(makeRequest("POST", "/api/projects", body), on);

    test("creates a project and its first source, the checkout on the chosen node", async () => {
      getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
      connectLoopbackNode(state, { nodeId: "remote" });
      await loopbackLink(state, "remote").ready();
      const res = await create({ name: "Test", path: tempDir, nodeId: "remote" });
      expect(res!.status).toBe(201);
      const body = await res!.json();
      expect(body).toEqual(expect.objectContaining({ name: "Test", base_branch: "main" }));
      expect(body).not.toHaveProperty("path");
      expect(defaultSource(body.id)).toMatchObject({ node_id: "remote", path: tempDir });
      await stopLoopbackNode(state, "remote");
    });

    test("detects the base branch in the new checkout, on its node", async () => {
      const repo = await createTestRepo();
      try {
        await git(repo.dir, ["branch", "-m", "main", "master"]);
        const res = await create({ name: "Detected", path: repo.dir, nodeId: SEEDED_NODE_ID });
        expect(res!.status).toBe(201);
        expect((await res!.json()).base_branch).toBe("master");
      } finally {
        repo.cleanup();
      }
    });

    test("refuses an unknown node, or a path that is not a directory on the node, creating nothing", async () => {
      const unknown = await create({ name: "Test", path: tempDir, nodeId: "nowhere" });
      expect(unknown!.status).toBe(400);
      expect((await unknown!.json()).error).toBe("Node not found");

      const missing = await create({ name: "Test", path: "/tmp/nonexistent-path-xyz", nodeId: SEEDED_NODE_ID });
      expect(missing!.status).toBe(400);
      expect((await missing!.json()).error).toBe("Directory does not exist: /tmp/nonexistent-path-xyz");
      expect(listProjects()).toEqual([]);
    });

    test("with the chosen node offline, answers 503 and creates nothing", async () => {
      const offline = createServerState();
      for (const body of [{ name: "Offline", path: tempDir, nodeId: SEEDED_NODE_ID }, { name: "Named", path: tempDir, nodeId: SEEDED_NODE_ID, base_branch: "trunk" }]) {
        expect((await create(body, offline))!.status).toBe(503);
      }
      expect(listProjects()).toEqual([]);
      offline.nodes.close();
    });

    test("returns 400 when name, path or node is missing", async () => {
      for (const body of [{ path: tempDir, nodeId: SEEDED_NODE_ID }, { name: "Test", nodeId: SEEDED_NODE_ID }, { name: "Test", path: tempDir }]) {
        expect((await create(body))!.status).toBe(400);
      }
    });

    test("returns 409 on duplicate path", async () => {
      createProject("First", tempDir);
      const res = await create({ name: "Second", path: tempDir, nodeId: SEEDED_NODE_ID });
      expect(res!.status).toBe(409);
      const body = await res!.json();
      expect(body.error).toBe("That checkout already belongs to a project");
    });
  });

  describe("PATCH /api/projects/:id", () => {
    test("updates a project name", async () => {
      const p = createProject("Original", tempDir);
      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${p.id}`, { name: "Updated" }),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.name).toBe("Updated");
    });

    test("returns 404 for nonexistent project", async () => {
      const res = await router.handle(
        makeRequest("PATCH", "/api/projects/9999", { name: "Nope" }),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("returns 400 for empty name", async () => {
      const p = createProject("Original", tempDir);
      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${p.id}`, { name: "  " }),
        state,
      );
      expect(res!.status).toBe(400);
    });
  });

  describe("DELETE /api/projects/:id", () => {
    test("deletes a project with its sessions and tells their node to close them", async () => {
      const node = useFakeNode(state);
      await node.link.ready();
      const p = createProject("ToDelete", tempDir);
      createSession("s1", p.id, { agentRuntimeType: "pi" });
      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${p.id}`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ ok: true });
      expect(getSession("s1")).toBeNull();
      for (let i = 0; i < 100 && !node.closed.length; i++) await Bun.sleep(5);
      expect(node.closed).toEqual(["s1"]);
    });

    test("returns 404 for nonexistent project", async () => {
      const res = await router.handle(
        makeRequest("DELETE", "/api/projects/9999"),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});
