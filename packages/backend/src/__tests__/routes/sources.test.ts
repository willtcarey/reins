import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { useLoopbackState } from "../helpers/server-state.js";
import { connectLoopbackNode, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
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
    expect((await res!.json()).error).toBe("That path is already a source of another project");
  });

  test("adds a checkout of the project on another node once that node confirms the directory, telling browsers the node's new source", async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const checkout = dir();
    connectLoopbackNode(loopback.state, { nodeId: "remote" });
    const received: Array<{ type: string; node?: { id: string; sources: unknown[] } }> = [];
    loopback.state.clients.add({ ws: { send: data => { received.push(JSON.parse(data)); return 0; } } });
    const project = createProject("Test", dir());
    try {
      const res = await router.handle(makeRequest("POST", `/api/projects/${project.id}/sources`, { nodeId: "remote", path: checkout }), loopback.state);

      expect(res!.status).toBe(201);
      const sourceId = getDb().query<{ id: number }, [string]>("SELECT id FROM sources WHERE node_id = ?").get("remote")!.id;
      expect(await res!.json()).toEqual({ id: sourceId, nodeId: "remote", nodeName: "Remote", connected: true, path: checkout });
      expect(received.filter(message => message.type === "node_updated").at(-1)!.node).toMatchObject({
        id: "remote", sources: [{ path: checkout, project: { id: project.id, name: "Test", sourceId } }],
      });
    } finally { await stopLoopbackNode(loopback.state, "remote"); }
  });

  test("refuses a path that is not an absolute directory on the node (400), a checkout another project has (409), a second checkout of the project on one node (409), an unknown or removed node (400) and an offline node (503), keeping nothing", async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote'), ('offline', 'Offline')");
    getDb().exec("INSERT INTO nodes (id, name, removed_at) VALUES ('gone', 'Gone', '2026-10-11T09:00:00.000Z')");
    const taken = dir();
    const missing = join(dir(), "missing");
    connectLoopbackNode(loopback.state, { nodeId: "remote" });
    const project = createProject("Test", dir());
    createSource(createProject("Other", dir()).id, "remote", taken);
    const sources = () => getDb().query("SELECT project_id, node_id, path FROM sources ORDER BY id").all();
    const before = sources();
    const add = async (body: { nodeId: string; path: string }) => {
      const res = await router.handle(makeRequest("POST", `/api/projects/${project.id}/sources`, body), loopback.state);
      return { status: res!.status, body: await res!.json() };
    };
    try {
      expect(await add({ nodeId: "remote", path: missing })).toEqual({ status: 400, body: { error: `Directory does not exist: ${missing}` } });
      expect(await add({ nodeId: "remote", path: "srv/app" })).toEqual({ status: 400, body: { error: "A source's path must be absolute: srv/app" } });
      expect(await add({ nodeId: "remote", path: taken })).toEqual({ status: 409, body: { error: "That path is already a source of another project" } });
      expect(await add({ nodeId: SEEDED_NODE_ID, path: dir() })).toEqual({ status: 409, body: { error: "The project already has a source on Internal" } });
      expect(await add({ nodeId: "nowhere", path: taken })).toEqual({ status: 400, body: { error: "Node not found: nowhere" } });
      expect(await add({ nodeId: "gone", path: dir() })).toEqual({ status: 400, body: { error: "Node not found: gone" } });
      expect((await add({ nodeId: "offline", path: dir() })).status).toBe(503);
      expect(sources()).toEqual(before);
    } finally { await stopLoopbackNode(loopback.state, "remote"); }
  });
});
