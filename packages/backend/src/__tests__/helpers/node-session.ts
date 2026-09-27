import { scheduleWork } from "../../models/node-command-projection.js";
import { claimCommand, enqueueInput, getCommand, settleCommand } from "../../node-command-store.js";
import { persistCanonicalMessages } from "./canonical-messages.js";
import { selectCreationSource } from "../../runtimes/node-source.js";
import { createSession } from "../session-fixture.js";

/** A node-owned session whose provision the node already admitted. Server projections only: no node
 * runtime is involved, as if the node ran in another process. */
export function createProvisionedNodeSession(
  id: string,
  projectId: number,
  opts: { taskId?: number; parentSessionId?: string } = {},
): void {
  const sourceId = selectCreationSource(projectId).id;
  const provisionId = `${id}-provision`;
  scheduleWork(provisionId, { op: "session.provision", sessionId: id, sourceId, configuration: { model: null, thinkingLevel: null, task: null } },
    () => createSession(id, projectId, { agentRuntimeType: "pi", ...opts, sourceId, storageOwner: "internal-node" }));
  claimCommand(provisionId);
  settleCommand(provisionId, "admitted", JSON.stringify({ ok: true, value: { kind: "provisioned" } }));
}

/** Queues a prompt in the node command outbox (no dispatcher wake); returns its command ID. */
export function queuePrompt(sessionId: string, clientId: string, text = "Work"): string {
  const id = enqueueInput(sessionId, "prompt", [{ type: "text", text }], clientId);
  if (!id) throw new Error(`Input ${clientId} was already admitted`);
  return id;
}

/** Moves a queued input through delivery to node admission, as the dispatcher would: the node's commit
 * of the admitted `reinsInput` reaches the replica before its reply settles (and deletes) the command. */
export function admitInput(commandId: string, clientId: string, text = "Work"): void {
  const command = getCommand(commandId);
  if (!command) throw new Error(`No pending command ${commandId}`);
  persistCanonicalMessages(command.session_id, [{ role: "user", content: [{ type: "text", text }], clientId, timestamp: 1 }]);
  claimCommand(commandId);
  settleCommand(commandId, "admitted", JSON.stringify({ ok: true, value: { kind: "admitted", inputId: clientId } }));
}
