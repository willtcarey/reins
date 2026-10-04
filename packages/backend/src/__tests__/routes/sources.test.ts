import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { useLoopbackState } from "../helpers/server-state.js";
import { SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { createSource, defaultSource } from "../../node-store.js";
import { getDb } from "../../db.js";

describe("source routes", () => {
  let router: ReturnType<typeof buildRouter>;
  let dirs: string[];
  const dir = () => { const made = mkdtempSync(join(tmpdir(), "reins-test-sources-")); dirs.push(made); return made; };

  useTestDb();
  const loopback = useLoopbackState();

  beforeEach(() => {
    router = buildRouter();
    dirs = [];
  });
  afterEach(() => { for (const made of dirs) rmSync(made, { recursive: true, force: true }); });

  test("lists the project's sources, its default one first, with their node", async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const first = dir();
    const project = createProject("Test", first);
    const remote = createSource(project.id, "remote", "/remote/checkout");

    const res = await router.handle(makeRequest("GET", `/api/projects/${project.id}/sources`), loopback.state);
    expect(await res!.json()).toEqual([
      { id: defaultSource(project.id)!.id, nodeId: SEEDED_NODE_ID, nodeName: "Internal", connected: true, path: first },
      { id: remote.id, nodeId: "remote", nodeName: "Remote", connected: false, path: "/remote/checkout" },
    ]);
  });

  test("moves a source to another path once its node confirms the directory", async () => {
    const project = createProject("Test", dir());
    const source = defaultSource(project.id)!;
    const patch = (sourceId: number, path: string) => router.handle(makeRequest("PATCH", `/api/projects/${project.id}/sources/${sourceId}`, { path }), loopback.state);

    const missing = await patch(source.id, "/tmp/nonexistent-path-xyz");
    expect(missing!.status).toBe(400);
    expect((await missing!.json()).error).toBe("Directory does not exist: /tmp/nonexistent-path-xyz");
    expect(defaultSource(project.id)!.path).toBe(source.path);

    const moved = dir();
    const res = await patch(source.id, moved);
    expect(res!.status).toBe(200);
    expect((await res!.json()).path).toBe(moved);
    expect(defaultSource(project.id)!.path).toBe(moved);

    expect((await patch(99_999, moved))!.status).toBe(404);
  });

  test("refuses moving a source onto a checkout another project has", async () => {
    const taken = dir();
    createProject("Other", taken);
    const project = createProject("Test", dir());

    const res = await router.handle(makeRequest("PATCH", `/api/projects/${project.id}/sources/${defaultSource(project.id)!.id}`, { path: taken }), loopback.state);
    expect(res!.status).toBe(409);
    expect((await res!.json()).error).toBe("That checkout already belongs to a project");
  });
});
