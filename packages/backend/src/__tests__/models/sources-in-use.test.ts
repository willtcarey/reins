import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useLoopbackState } from "../helpers/app-state.js";
import { SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { createProject } from "../project-fixture.js";
import { createTask } from "../../task-store.js";
import { getDb } from "../../app-globals.js";
import { getProject } from "../../project-store.js";
import { Models } from "../../models/models.js";

/** The nodes whose sources in use (Settings → Nodes: each path with the projects working there) are
 * announced to browsers as changes are made, and only those. */
describe("a node's sources in use, as browsers are told of them", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  let announced: Array<{ id: string; sources: Array<{ path: string; projects: Array<{ name: string }> }> }>;
  let models: Models;

  beforeEach(() => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('laptop', 'Laptop')");
    getDb().exec("INSERT INTO sources (node_id, path) VALUES ('laptop', '/laptop/checkout')");
    announced = [];
    loopback.state.process.clients.add({ ws: { send: data => {
      const message = JSON.parse(data);
      if (message.type === "node_updated") announced.push(message.node);
      return 0;
    } } });
    models = new Models(loopback.state);
  });

  const laptop = { nodeId: "laptop", path: "/laptop/checkout" };
  const nodesAnnounced = () => announced.map(node => node.id);

  test("a session made where its project did not work yet tells that node; another there tells nothing", async () => {
    const project = createProject("Reins", repo.dir);

    await models.sessions.create({ projectId: project.id, source: laptop });
    expect(announced).toEqual([expect.objectContaining({ id: "laptop", sources: [expect.objectContaining({ path: "/laptop/checkout", projects: [expect.objectContaining({ name: "Reins" })] })] })]);

    announced = [];
    await models.sessions.create({ projectId: project.id, source: laptop });
    expect(announced).toEqual([]);
  });

  test("moving a session tells the node it left and the node it went to", async () => {
    const project = createProject("Reins", repo.dir);
    const { id } = await models.sessions.create({ projectId: project.id, source: laptop });
    announced = [];

    await models.sessions.move(id, { nodeId: SEEDED_NODE_ID, path: `${repo.dir}/..` });

    expect(nodesAnnounced().toSorted()).toEqual([SEEDED_NODE_ID, "laptop"]);
  });

  test("deleting a task tells the nodes its sessions worked on", async () => {
    const project = createProject("Reins", repo.dir);
    const task = createTask(project.id, "Elsewhere", null, "task/elsewhere");
    await models.sessions.create({ projectId: project.id, taskId: task.id, source: laptop });
    announced = [];

    await models.project(project.id).tasks().delete(task.id, loopback.state.process);

    expect(nodesAnnounced()).toEqual(["laptop"]);
  });

  test("renaming a project tells the nodes it works on", async () => {
    const project = createProject("Reins", repo.dir);
    await models.sessions.create({ projectId: project.id, source: laptop });
    announced = [];

    await models.projects.update(project.id, { name: "Renamed" });

    expect(nodesAnnounced().toSorted()).toEqual([SEEDED_NODE_ID, "laptop"]);
    expect(announced.find(node => node.id === "laptop")?.sources[0]?.projects).toEqual([expect.objectContaining({ name: "Renamed" })]);
  });

  test("deleting a project tells the nodes it worked on; its sessions go with it", async () => {
    const project = createProject("Reins", repo.dir);
    await models.sessions.create({ projectId: project.id, source: laptop });
    announced = [];

    await models.projects.delete(project.id);

    expect(getProject(project.id)).toBeNull();
    expect(nodesAnnounced().toSorted()).toEqual([SEEDED_NODE_ID, "laptop"]);
    expect(announced.every(node => node.sources.length === 0)).toBe(true);
  });
});
