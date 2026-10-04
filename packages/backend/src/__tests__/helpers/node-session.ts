import { claimCommand, enqueueInput, getCommand, settleCommand } from "../../node-link/node-command-store.js";
import { persistCanonicalMessages } from "./canonical-messages.js";
import { resolveSource } from "../../models/sources.js";
import { createSession } from "../session-fixture.js";
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession as insertSession } from "../../session-store.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import type { NodeHubOptions } from "../../node-link/node-hub.js";
import { createServerState } from "./server-state.js";
import { loopbackLink, stopLoopbackNode } from "./loopback-node.js";
import { registerPiProvider, unregisterPiProvider } from "./pi-providers.js";

/** A session on its project's default source's node. Server projections only: no node runtime is
 * involved, as if the node ran in another process. */
export function createNodeSession(
  id: string,
  projectId: number,
  opts: { taskId?: number; parentSessionId?: string } = {},
): void {
  createSession(id, projectId, { agentRuntimeType: "pi", ...opts, sourceId: resolveSource(projectId).id });
}

/** Queues a prompt in the node command outbox (no dispatcher wake); returns its command ID. */
export function queuePrompt(sessionId: string, clientId: string, text = "Work"): string {
  const id = enqueueInput(sessionId, "prompt", [{ type: "text", text }], clientId);
  if (!id) throw new Error(`Input ${clientId} was already admitted`);
  return id;
}

/** Moves a queued input through delivery to node admission, as the dispatcher would: the node's commit
 * of the admitted `reinsInput` reaches the server's storage before its reply settles (and deletes) the command. */
export function admitInput(commandId: string, clientId: string, text = "Work"): void {
  const command = getCommand(commandId);
  if (!command) throw new Error(`No pending command ${commandId}`);
  persistCanonicalMessages(command.session_id, [{ role: "user", content: [{ type: "text", text }], clientId, timestamp: 1 }]);
  claimCommand(commandId);
  settleCommand(commandId, "admitted", JSON.stringify({ ok: true, value: { inputId: clientId } }));
}

/** Session "s" on the seeded node's in-process loopback link, on a faux model whose replies the test
 * scripts; its own in-memory database. `hub`: hub options (e.g. short command timeouts). */
export async function nodeSession(name: string, responses: FauxResponseStep[] = [], hub?: NodeHubOptions) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const provider = fauxProvider({ provider: name, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }, { id: "other" }] });
  provider.setResponses(responses);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const state = createServerState(undefined, { loopbackNode: true, hub });
  const project = createProject(name, "/tmp/node-commands");
  const source = defaultSource(project.id)!;
  insertSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: provider.provider.id, modelId: "fake" });
  await loopbackLink(state).ready();
  // Settled runs as the server applied them from the node's lifecycle reports.
  const settled = () => db.query<{ n: number }, []>("SELECT settlement_count n FROM sessions WHERE id = 's'").get()!.n;
  // Runs the model answered, in the server's storage: a duplicate admission would add one.
  const replies = () => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND role = 'assistant'").get()!.n;
  const untilSettled = async (runs: number) => { for (let i = 0; i < 400 && settled() < runs; i++) await Bun.sleep(5); expect(settled()).toBe(runs); };
  // Inputs Pi holds for a client ID in the session's transcript.
  const inputs = (clientId: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND message_json LIKE ?").get(`%"reinsId":"${clientId}"%`)!.n;
  // Pi's main lane configuration (its model), in the server's storage.
  const lane = () => JSON.parse(db.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()!.value_json);
  const dispose = async () => { await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id); setDb(new Database(":memory:")); db.close(); };
  return { db, state, project, source, target: state.nodes, provider, settled, untilSettled, inputs, replies, lane, dispose };
}
