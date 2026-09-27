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
import { enqueueSessionInput, executeSessionCommand } from "../../runtimes/node-execution.js";
import { executionTargetFor, registerExecutionTarget, type SessionExecutionTarget } from "../../runtimes/execution-target.js";
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

test("resolver returns the installed target; a superseded registration's uninstall leaves the newer one", () => {
  const state: ServerState = { clients: new Set(), frontendDir: "" };
  expect(() => executionTargetFor(state)).toThrow("Session execution target unavailable");
  const node = recordingTarget().target;
  const unregister = registerExecutionTarget(state, node);
  expect(executionTargetFor(state)).toBe(node);
  // A hot-reloaded handler registers its own target before the old one uninstalls.
  const replacement = recordingTarget().target;
  registerExecutionTarget(state, replacement);
  unregister();
  expect(executionTargetFor(state)).toBe(replacement);
});

test("dispatcher delivers provision, prompt and steer through the target with outbox command IDs; a session at rest moves onto its node first", withDb(async (projectId, sourceId) => {
  scheduleWork("node-provision", { op: "session.provision", sessionId: "node", sourceId, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
    createSession("node", projectId, { agentRuntimeType: "pi", sourceId, placementStatus: "provisioning" }));
  createSession("at-rest", projectId, { agentRuntimeType: "pi", sourceId });
  const state = createServerState();
  const node = recordingTarget();
  registerExecutionTarget(state, node.target);
  const content = [{ type: "text" as const, text: "hi" }];
  const ids = [enqueueInput("node", "prompt", content, "node-p")!, enqueueInput("node", "steer", content, "node-s")!];
  enqueueSessionInput("at-rest", "prompt", content, "at-rest-p");
  await new NodeCommandDispatcher(state).drain();
  // Delivered commands leave the outbox; provision and move settle each session's placement.
  for (const id of ["node-provision", ...ids]) expect(getWork(id)).toBeNull();
  expect([getSession("node")?.placement_status, getSession("at-rest")?.placement_status]).toEqual(["provisioned", "provisioned"]);
  const sentFor = (sessionId: string) => node.sent.filter(([command]) => command.sessionId === sessionId);
  expect(delivered(sentFor("node"))).toEqual([["session.provision", "node-provision"], ["session.prompt", ids[0]], ["session.steer", ids[1]]]);
  expect(sentFor("at-rest").map(([command]) => command.op)).toEqual(["session.hydrate", "session.prompt"]);

  // Immediate controls resolve the same target after admission, without an outbox command ID.
  await executeSessionCommand(state, "node", "abort");
  await executeSessionCommand(state, "at-rest", "resumePending");
  expect(node.sent.at(-2)).toEqual([{ op: "session.abort", sessionId: "node" }, undefined]);
  expect(node.sent.at(-1)).toEqual([{ op: "session.resumePending", sessionId: "at-rest" }, undefined]);
}));

test("a model change is queued in outbox order: after earlier input, before later input; a session at rest on the server is moved onto its node first", withDb(async (projectId, sourceId) => {
  scheduleWork("node-provision", { op: "session.provision", sessionId: "node", sourceId, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
    createSession("node", projectId, { agentRuntimeType: "pi", sourceId, placementStatus: "provisioning", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" }));
  createSession("legacy", projectId, { agentRuntimeType: "pi", sourceId, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
  const state = createServerState();
  const node = recordingTarget();
  registerExecutionTarget(state, node.target);
  const content = [{ type: "text" as const, text: "hi" }];
  const before = enqueueInput("node", "prompt", content, "before")!;
  let wakes = 0;
  const sessions = new Sessions(undefined, () => { wakes++; });
  // Returns the updated row at once; the node applies the change when the command is delivered.
  const row = await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" });
  expect(row).toMatchObject({ model_provider: "anthropic", model_id: "claude-haiku-4-5", thinking_level: "high" });
  expect(wakes).toBe(1);
  const after = enqueueInput("node", "steer", content, "after")!;
  await new NodeCommandDispatcher(state).drain();
  expect(node.sent.map(([command]) => command)).toEqual([
    { op: "session.provision", sessionId: "node", sourceId, configuration: { model: null, thinkingLevel: null, task: null } },
    expect.objectContaining({ op: "session.prompt", clientId: "before" }),
    { op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" },
    expect.objectContaining({ op: "session.steer", clientId: "after" }),
  ]);
  expect([getWork(before), getWork(after)]).toEqual([null, null]);

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
    createSession("node", projectId, { agentRuntimeType: "pi", sourceId, placementStatus: "provisioning" }));
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; error?: string }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  const rejecting: SessionExecutionTarget = {
    async send(command) {
      if (command.op === "session.setModel") return { ok: false, error: { code: "invalid_request", message: `Model not found: ${command.provider}/${command.modelId}`, retryable: false } };
      return { ok: true, value: { kind: "provisioned" } };
    },
  };
  registerExecutionTarget(state, rejecting);
  await new Sessions().setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5" });
  await new NodeCommandDispatcher(state).drain();
  expect(sent).toContainEqual({ type: "error", sessionId: "node", error: "Model change failed: Model not found: anthropic/claude-haiku-4-5" });
  // Like other failed commands, it is removed after notification so later work can proceed.
  expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE json_extract(command_json, '$.op') = 'session.setModel'").get()).toBeNull();
}));
