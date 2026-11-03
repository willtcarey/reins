import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState } from "../helpers/app-state.js";
import { createProject } from "../project-fixture.js";
import { upsertSource, defaultSource } from "../../node-store.js";
import { SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { Models } from "../../models/models.js";
import { createSession as insertSession } from "../../session-store.js";

describe("Models", () => {
  useTestDb();

  test("each getter returns the same model within one Models", () => {
    const models = new Models(createAppState());

    expect(models.broadcast).toBe(models.broadcast);
    expect(models.nodes).toBe(models.nodes);
    expect(models.sessions).toBe(models.sessions);
  });

  test("broadcast reaches the state's browser clients", () => {
    const sent: string[] = [];
    const models = new Models(createAppState({ clients: new Set([{ ws: { send: (data: string) => sent.push(data) } }]) }));

    models.broadcast({ type: "task_updated", projectId: 7 });

    expect(sent.map(frame => JSON.parse(frame))).toEqual([{ type: "task_updated", projectId: 7 }]);
  });

  test("a project's model works in its default source, whoever asks; a session's in its own source", () => {
    const project = createProject("Test", "/tmp/first");
    const second = upsertSource(SEEDED_NODE_ID, "/tmp/second");
    const models = new Models(createAppState());
    insertSession("elsewhere", project.id, { agentRuntimeType: "pi", sourceId: second.id });

    expect(models.project(project.id).defaultSource.record).toEqual(defaultSource(project.id)!);
    expect(models.project(project.id).defaultSource.path).toBe("/tmp/first");
    expect(models.sessions.get("elsewhere").source.record).toEqual(second);
    expect(models.sessions.get("elsewhere").baseBranch).toBe("main");
  });
});
