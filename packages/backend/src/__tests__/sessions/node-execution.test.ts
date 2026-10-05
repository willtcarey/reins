import { test, expect, spyOn } from "bun:test";
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
import { abortSession, resumeSession, submit } from "../../sessions/node-execution.js";
import { createServerState } from "../helpers/server-state.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { nodeSession } from "../helpers/node-session.js";
import { loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";

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
    expect(new Sessions(state.nodes).get("s")?.placement).toEqual({ available: true, nodeId: "internal", nodeName: "Internal", path: "/tmp/node-commands" });
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

test("abort and resume call the session's node at once and are never queued: an offline node is `unavailable`, a refusal is the node's NodeError", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId });
  const state = createServerState();
  await expect(abortSession(state.nodes, "node")).rejects.toMatchObject({
    message: "Node unavailable: Node not connected", error: { code: "unavailable", message: "Node unavailable: Node not connected", retryable: true } });
  const node = useFakeNode(state);
  await node.link.ready();
  expect(await abortSession(state.nodes, "node")).toEqual({ aborted: false });
  expect(await resumeSession(state.nodes, "node")).toEqual({ started: true });
  expect(node.sent).toEqual([{ op: "session.abort", sessionId: "node" }, { op: "session.resumePending", sessionId: "node" }]);
  node.reject("session.resumePending", "nothing to resume");
  await expect(resumeSession(state.nodes, "node")).rejects.toMatchObject({
    message: "nothing to resume", error: { code: "invalid_request", message: "nothing to resume", retryable: false } });
  await expect(abortSession(state.nodes, "missing")).rejects.toThrow("Session not found: missing");
  expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
}));

test("over a real node, abort stops a running run, and with nothing running answers so without starting anything; nothing pending to resume is the node's refusal", async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { db, state, untilSettled, dispose } = await nodeSession("abort-session", [
    (_context, options) => new Promise(resolve => {
      started();
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" })), { once: true });
    }),
  ]);
  try {
    expect(await abortSession(state.nodes, "s")).toEqual({ aborted: false });
    await expect(resumeSession(state.nodes, "s")).rejects.toMatchObject({
      error: { code: "internal", message: "Lane 'main' has no pending inactive operation", retryable: false } });
    submit(state.nodes, "s", { op: "prompt", content: text("Work"), clientId: "long" });
    await running;
    expect(await abortSession(state.nodes, "s")).toEqual({ aborted: true });
    await untilSettled(1);
    expect(db.query("SELECT settlement_json FROM sessions WHERE id = 's'").get()).toMatchObject({ settlement_json: expect.stringContaining('"status":"aborted"') });
  } finally { await dispose(); }
}, 15_000);

test("a direct call whose outcome is unknown (its link dropped) fails to its caller as `unavailable` and is not retried", async () => {
  const { state, dispose } = await nodeSession("call-unknown");
  try {
    const resumes = spyOn(loopbackNodeFor(state), "resumePending").mockReturnValue(new Promise(() => {}));
    const pending = resumeSession(state.nodes, "s");
    for (let i = 0; i < 200 && resumes.mock.calls.length === 0; i++) await Bun.sleep(5);
    await stopLoopbackNode(state);
    await expect(pending).rejects.toMatchObject({
      error: { code: "unavailable", message: "Node unavailable: Connection closed; outcome unknown", retryable: true } });
    expect(resumes).toHaveBeenCalledTimes(1);
    expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { await dispose(); }
});
