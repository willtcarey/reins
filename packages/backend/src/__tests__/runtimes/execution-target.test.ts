import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
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
    .send({ op: "session.provision", sessionId: "legacy", sourceId }, "p")
    .then(result => {
      expect(result).toEqual({ ok: true, value: { kind: "provisioned" } });
      expect(state.sessions.has("legacy")).toBe(false);
    });
}));

test("dispatcher delivers provision, prompt and steer for both owners through their targets with outbox receipts", withDb(async (projectId, sourceId) => {
  for (const [id, storageOwner] of [["node", "internal-node"], ["legacy", "server"]] as const) {
    scheduleWork(`${id}-provision`, { op: "session.provision", sessionId: id, sourceId }, () =>
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
