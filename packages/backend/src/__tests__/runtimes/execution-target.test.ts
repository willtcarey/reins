import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { getDb } from "../../db.js";
import { Sessions } from "../../models/sessions.js";
import { internalSource } from "../../node-store.js";
import { enqueueInput } from "../../node-command-store.js";
import { scheduleWork, getWork } from "../../models/node-command-projection.js";
import { NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";
import { executeSessionCommand } from "../../runtimes/node-execution.js";
import { executionTargetFor, registerExecutionTargets, type SessionExecutionTarget } from "../../runtimes/execution-target.js";
import type { ServerState } from "../../state.js";
import { createServerState } from "../helpers/server-state.js";

function recordingTarget() {
  const sent: Array<[NodeCommand, string | undefined]> = [];
  const target: SessionExecutionTarget = {
    async send(command, commandId): Promise<NodeResult> {
      sent.push([command, commandId]);
      switch (command.op) {
        case "session.provision": return { ok: true, value: { kind: "provisioned" } };
        case "session.prompt": case "session.steer": return { ok: true, value: { kind: "admitted", inputId: command.clientId } };
        case "session.abort": return { ok: true, value: { kind: "aborted", aborted: true } };
        case "session.resumePending": return { ok: true, value: { kind: "resumed", started: true } };
        case "session.setModel": return { ok: true, value: { kind: "modelSet" } };
        case "session.hydrate": return { ok: true, value: { kind: "hydrated" } };
        case "session.release": return { ok: false, error: { code: "unsupported", message: "not recorded", retryable: false } };
      }
    },
  };
  return { target, sent };
}

const delivered = (sent: Array<[NodeCommand, string | undefined]>) => sent.map(([command, commandId]) => [command.op, commandId]);

function withDb(run: (projectId: number, sourceId: number) => Promise<void> | void) {
  return async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
    try {
      const project = createProject("targets", "/tmp/targets");
      await run(project.id, internalSource(project.id).id);
    } finally { setDb(new Database(":memory:")); db.close(); }
  };
}

test("resolver selects the target registered for the session's storage owner", () => {
  const state: ServerState = { sessions: new Map(), clients: new Set(), frontendDir: "" };
  expect(() => executionTargetFor(state, { id: "s", storage_owner: "server" })).toThrow("Session execution targets unavailable");
  const node = recordingTarget().target;
  const server = recordingTarget().target;
  const unregister = registerExecutionTargets(state, { "internal-node": node, server });
  expect(executionTargetFor(state, { id: "a", storage_owner: "internal-node" })).toBe(node);
  expect(executionTargetFor(state, { id: "b", storage_owner: "server" })).toBe(server);
  // A superseded (hot-reloaded) registration's uninstall leaves the newer one in place.
  const replacement = recordingTarget().target;
  registerExecutionTargets(state, { "internal-node": replacement, server });
  unregister();
  expect(executionTargetFor(state, { id: "a", storage_owner: "internal-node" })).toBe(replacement);
});

test("installed legacy target admits provision without opening a runtime", withDb((projectId, sourceId) => {
  createSession("legacy", projectId, { agentRuntimeType: "pi", sourceId, storageOwner: "server" });
  const state = createServerState();
  return executionTargetFor(state, { id: "legacy", storage_owner: "server" })
    .send({ op: "session.provision", sessionId: "legacy", sourceId, configuration: { model: null, thinkingLevel: null, task: null } }, "p")
    .then(result => {
      expect(result).toEqual({ ok: true, value: { kind: "provisioned" } });
      expect(state.sessions.has("legacy")).toBe(false);
    });
}));

test("dispatcher delivers provision, prompt and steer for both owners through their targets with outbox receipts", withDb(async (projectId, sourceId) => {
  for (const [id, storageOwner] of [["node", "internal-node"], ["legacy", "server"]] as const) {
    scheduleWork(`${id}-provision`, { op: "session.provision", sessionId: id, sourceId, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
      createSession(id, projectId, { agentRuntimeType: "pi", sourceId, storageOwner }));
  }
  const state = createServerState();
  const node = recordingTarget();
  const server = recordingTarget();
  registerExecutionTargets(state, { "internal-node": node.target, server: server.target });
  const content = [{ type: "text" as const, text: "hi" }];
  const ids = ["node", "legacy"].flatMap(id => [
    enqueueInput(id, "prompt", content, `${id}-p`),
    enqueueInput(id, "steer", content, `${id}-s`),
  ]);
  await new NodeCommandDispatcher(state).drain();
  for (const id of ["node-provision", "legacy-provision", ...ids]) expect(getWork(id)?.state).toBe("admitted");
  expect(delivered(node.sent)).toEqual([["session.provision", "node-provision"], ["session.prompt", ids[0]], ["session.steer", ids[1]]]);
  expect(delivered(server.sent)).toEqual([["session.provision", "legacy-provision"], ["session.prompt", ids[2]], ["session.steer", ids[3]]]);

  // Immediate controls resolve the same target after admission, without an outbox receipt.
  await executeSessionCommand(state, "node", "abort");
  await executeSessionCommand(state, "legacy", "resumePending");
  expect(node.sent.at(-1)).toEqual([{ op: "session.abort", sessionId: "node" }, undefined]);
  expect(server.sent.at(-1)).toEqual([{ op: "session.resumePending", sessionId: "legacy" }, undefined]);
}));

test("a model change is queued in outbox order: after earlier input, before later input; a session at rest on the server is moved onto its node first", withDb(async (projectId, sourceId) => {
  for (const [id, storageOwner] of [["node", "internal-node"], ["legacy", "server"]] as const) {
    scheduleWork(`${id}-provision`, { op: "session.provision", sessionId: id, sourceId, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
      createSession(id, projectId, { agentRuntimeType: "pi", sourceId, storageOwner, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" }));
  }
  const state = createServerState();
  const node = recordingTarget();
  registerExecutionTargets(state, { "internal-node": node.target, server: recordingTarget().target });
  const content = [{ type: "text" as const, text: "hi" }];
  const before = enqueueInput("node", "prompt", content, "before");
  let wakes = 0;
  const sessions = new Sessions(state.sessions, undefined, () => { wakes++; });
  // Returns the updated row at once; the node applies the change when the command is delivered.
  const row = await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" });
  expect(row).toMatchObject({ model_provider: "anthropic", model_id: "claude-haiku-4-5", thinking_level: "high" });
  expect(wakes).toBe(1);
  const after = enqueueInput("node", "steer", content, "after");
  await new NodeCommandDispatcher(state).drain();
  expect(node.sent.map(([command]) => command)).toEqual([
    { op: "session.provision", sessionId: "node", sourceId, configuration: { model: null, thinkingLevel: null, task: null } },
    expect.objectContaining({ op: "session.prompt", clientId: "before" }),
    { op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" },
    expect.objectContaining({ op: "session.steer", clientId: "after" }),
  ]);
  expect([getWork(before)?.state, getWork(after)?.state]).toEqual(["admitted", "admitted"]);

  // Without a thinking level the command leaves Pi's level alone.
  await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-sonnet-4-5" });
  await new NodeCommandDispatcher(state).drain();
  expect(node.sent.at(-1)?.[0]).toEqual({ op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-sonnet-4-5" });

  await sessions.setModel({ sessionId: "legacy", provider: "anthropic", modelId: "claude-haiku-4-5" });
  expect(wakes).toBe(3);
  expect(getSession("legacy")?.model_id).toBe("claude-haiku-4-5");
  // The lazy trigger: hydrate first (no lane seed: the caller's own model change follows), then the change.
  expect(getDb().query<{ op: string }, []>("SELECT json_extract(command_json, '$.op') op FROM node_command_outbox WHERE session_id = 'legacy' AND state = 'queued' ORDER BY rowid").all())
    .toEqual([{ op: "session.hydrate" }, { op: "session.setModel" }]);
}));

test("a node's model change rejection is a failed command, reported to every client viewing the session", withDb(async (projectId, sourceId) => {
  scheduleWork("provision", { op: "session.provision", sessionId: "node", sourceId, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
    createSession("node", projectId, { agentRuntimeType: "pi", sourceId, storageOwner: "internal-node" }));
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; error?: string }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  const rejecting: SessionExecutionTarget = {
    async send(command) {
      if (command.op === "session.setModel") return { ok: false, error: { code: "invalid_request", message: `Model not found: ${command.provider}/${command.modelId}`, retryable: false } };
      return { ok: true, value: { kind: "provisioned" } };
    },
  };
  registerExecutionTargets(state, { "internal-node": rejecting, server: recordingTarget().target });
  await new Sessions(state.sessions).setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5" });
  await new NodeCommandDispatcher(state).drain();
  expect(sent).toContainEqual({ type: "error", sessionId: "node", error: "Model change failed: Model not found: anthropic/claude-haiku-4-5" });
  // Like other failed commands, it is removed after notification so later work can proceed.
  expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE json_extract(command_json, '$.op') = 'session.setModel'").get()).toBeNull();
}));
