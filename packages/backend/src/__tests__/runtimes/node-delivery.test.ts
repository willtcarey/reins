import { test, expect } from "bun:test";
import type { NodeCommand } from "@reins/node-protocol";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { getDb } from "../../db.js";
import { Sessions } from "../../models/sessions.js";
import { createSource, defaultSource } from "../../node-store.js";
import { enqueueInput } from "../../node-command-store.js";
import { getNodeCommand } from "../../node-command-store.js";
import { enqueueSessionInput, executeSessionCommand } from "../../runtimes/node-execution.js";
import { createServerState } from "../helpers/server-state.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { drainCommands } from "../helpers/loopback-node.js";

const text = [{ type: "text" as const, text: "hi" }];
const ops = (commands: NodeCommand[]) => commands.map(command => [command.op, command.sessionId]);
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

test("the hub delivers prompt and steer to the session's node in outbox order; immediate controls go to the same node", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId });
  const state = createServerState();
  const node = useFakeNode(state);
  const ids = [enqueueInput("node", "prompt", text, "node-p")!, enqueueInput("node", "steer", text, "node-s")!];
  await drainCommands(state);
  // Delivered commands leave the outbox.
  for (const id of ids) expect(getNodeCommand(id)).toBeNull();
  expect(node.sent).toEqual([
    { op: "session.prompt", sessionId: "node", clientId: "node-p", content: text, sourceSessionId: null },
    { op: "session.steer", sessionId: "node", clientId: "node-s", content: text, sourceSessionId: null },
  ]);

  await executeSessionCommand(state, "node", "abort");
  await executeSessionCommand(state, "node", "resumePending");
  expect(node.sent.slice(-2)).toEqual([{ op: "session.abort", sessionId: "node" }, { op: "session.resumePending", sessionId: "node" }]);
}));

test("no node is special: work for sessions on a second node's source goes to that node when it connects, the seeded node's to it", withDb(async (projectId, sourceId) => {
  getDb().exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
  const remote = createSource(projectId, "remote", "/remote/targets");
  for (const [sessionId, source] of [["local", sourceId], ["far", remote.id]] as const) {
    createSession(sessionId, projectId, { agentRuntimeType: "pi", sourceId: source });
    enqueueSessionInput(sessionId, "prompt", text, `${sessionId}-p`);
  }
  const state = createServerState();
  const local = useFakeNode(state);
  await drainCommands(state);
  expect(ops(local.sent)).toEqual([["session.prompt", "local"]]);
  // The remote node is not connected: its session's work waits in the outbox.
  expect(new Sessions(state.nodes).get("far")?.placement).toEqual({ status: "provisioned", error: null, available: false, nodeId: "remote", nodeName: "Remote" });
  // An immediate control is not queued: it fails while the node is not connected.
  await expect(executeSessionCommand(state, "far", "abort")).rejects.toThrow("Node unavailable");

  const far = useFakeNode(state, "remote");
  await drainCommands(state);
  expect(ops(far.sent)).toEqual([["session.prompt", "far"]]);
  expect(new Sessions(state.nodes).get("far")?.placement).toMatchObject({ status: "provisioned", available: true, nodeId: "remote" });
  await executeSessionCommand(state, "far", "abort");
  await executeSessionCommand(state, "local", "abort");
  expect(far.sent.at(-1)).toEqual({ op: "session.abort", sessionId: "far" });
  expect(local.sent.at(-1)).toEqual({ op: "session.abort", sessionId: "local" });
  expect([far.sent.length, local.sent.length]).toEqual([2, 2]);
}));

test("a model change is queued in outbox order: after earlier input, before later input", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId, modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
  const state = createServerState();
  const node = useFakeNode(state);
  const before = enqueueInput("node", "prompt", text, "before")!;
  let wakes = 0;
  const sessions = new Sessions({ connected: nodeId => state.nodes.connected(nodeId), wake: async () => { wakes++; }, closeSession: async () => {} });
  // Returns the updated row at once; the node applies the change when the command is delivered.
  const row = await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" });
  expect(row).toMatchObject({ model_provider: "anthropic", model_id: "claude-haiku-4-5", thinking_level: "high" });
  expect(wakes).toBe(1);
  const after = enqueueInput("node", "steer", text, "after")!;
  await drainCommands(state);
  expect(node.sent).toEqual([
    expect.objectContaining({ op: "session.prompt", clientId: "before" }),
    { op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "high" },
    expect.objectContaining({ op: "session.steer", clientId: "after" }),
  ]);
  expect([getNodeCommand(before), getNodeCommand(after)]).toEqual([null, null]);

  // Without a thinking level the command leaves Pi's level alone.
  await sessions.setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-sonnet-4-5" });
  await drainCommands(state);
  expect(node.sent.at(-1)).toEqual({ op: "session.setModel", sessionId: "node", provider: "anthropic", modelId: "claude-sonnet-4-5" });

}));

test("a node's model change rejection is a failed command, reported to every client viewing the session", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId });
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; error?: string }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  useFakeNode(state).rejectWhen(command => command.op === "session.setModel" ? `Model not found: ${command.provider}/${command.modelId}` : null);
  await new Sessions(state.nodes).setModel({ sessionId: "node", provider: "anthropic", modelId: "claude-haiku-4-5" });
  await drainCommands(state);
  expect(sent).toContainEqual({ type: "error", sessionId: "node", error: "Model change failed: Model not found: anthropic/claude-haiku-4-5" });
  // Like other failed commands, it is removed after notification so later work can proceed.
  expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE json_extract(command_json, '$.op') = 'session.setModel'").get()).toBeNull();
}));
