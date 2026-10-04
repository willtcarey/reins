import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setDb, getDb } from "../../db.js";
import { storedInput } from "../../pi-session-store.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { pendingInputs } from "../../node-link/node-command-store.js";
import { Sessions } from "../../models/sessions.js";
import { control, submit } from "../../sessions/node-execution.js";
import { createServerState } from "../helpers/server-state.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { nodeSession } from "../helpers/node-session.js";

const text = (value: string) => [{ type: "text" as const, text: value }];
function withDb(run: (projectId: number, sourceId: number) => Promise<void> | void) {
  return async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
    try {
      const project = createProject("targets", "/tmp/targets");
      await run(project.id, defaultSource(project.id)!.id);
    } finally { setDb(new Database(":memory:")); db.close(); }
  };
}

test("submission wakes delivery once the enclosing transaction commits; a rolled-back submission queues nothing and its wake finds nothing", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId });
  // What each wake's scan finds pending.
  const scans: string[][] = [];
  const nodes = { wake: async () => { scans.push(pendingInputs("node").map(input => input.clientId)); } };
  const prompt = (clientId: string) => ({ op: "prompt" as const, content: text("hi"), clientId });

  getDb().transaction(() => {
    submit(nodes, "node", prompt("committed"));
    expect(scans).toEqual([]);
  })();
  await Bun.sleep(0);
  expect(scans).toEqual([["committed"]]);

  expect(() => getDb().transaction(() => {
    submit(nodes, "node", prompt("rolled-back"));
    throw new Error("rollback");
  })()).toThrow("rollback");
  await Bun.sleep(0);
  expect(scans).toEqual([["committed"], ["committed"]]);

  // The session's source is validated before anything is queued.
  expect(() => submit(nodes, "missing", prompt("nowhere"))).toThrow("Session not found: missing");
  await Bun.sleep(0);
  expect(scans).toHaveLength(2);
}));

test("input for a session runs on the node of its source, and the delivered input leaves the outbox", async () => {
  const { db, state, untilSettled, replies, dispose } = await nodeSession("session-input", [fauxAssistantMessage("Hello")]);
  try {
    expect(new Sessions(state.nodes).get("s")?.placement).toEqual({ available: true, nodeId: "internal", nodeName: "Internal" });
    submit(state.nodes, "s", { op: "prompt", content: text("Hi"), clientId: "c1" });
    await untilSettled(1);
    expect(replies()).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(storedInput("s", "c1")).toMatchObject({ seq: expect.any(Number) });
    // A replay of the admitted input is recognized from the server's storage and queues nothing.
    submit(state.nodes, "s", { op: "prompt", content: text("Hi"), clientId: "c1" });
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { await dispose(); }
}, 15_000);

test("a control is sent at once, never queued, and fails to its caller when the node rejects it or the session is unknown", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId });
  const state = createServerState();
  const node = useFakeNode(state);
  await node.link.ready();
  await control(state.nodes, "node", "abort");
  expect(node.sent).toEqual([{ op: "session.abort", sessionId: "node" }]);
  node.reject("session.resumePending", "nothing to resume");
  await expect(control(state.nodes, "node", "resumePending")).rejects.toThrow("nothing to resume");
  await expect(control(state.nodes, "missing", "abort")).rejects.toThrow("Session not found: missing");
  expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
}));
