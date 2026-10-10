import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { createProject } from "../project-fixture.js";
import { createSource, defaultSource } from "../../node-store.js";
import { SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { Models } from "../../models/models.js";

describe("Models", () => {
  useTestDb();

  test("each getter returns the same model within one Models", () => {
    const models = new Models(createServerState());

    expect(models.broadcast).toBe(models.broadcast);
    expect(models.nodes).toBe(models.nodes);
    expect(models.sessions).toBe(models.sessions);
  });

  test("broadcast reaches the state's browser clients", () => {
    const sent: string[] = [];
    const models = new Models(createServerState({ clients: new Set([{ ws: { send: (data: string) => sent.push(data) } }]) }));

    models.broadcast({ type: "task_updated", projectId: 7 });

    expect(sent.map(frame => JSON.parse(frame))).toEqual([{ type: "task_updated", projectId: 7 }]);
  });

  test("project works in the project's default source unless given one", () => {
    const project = createProject("Test", "/tmp/first");
    const second = createSource(project.id, SEEDED_NODE_ID, "/tmp/second");
    const models = new Models(createServerState());

    expect(models.project(project.id).source.record).toEqual(defaultSource(project.id)!);
    expect(models.project(project.id).source.path).toBe("/tmp/first");
    expect(models.project(project.id, null).source.path).toBe("/tmp/first");
    expect(models.project(project.id, second.id).source.record).toEqual(second);
  });
});
