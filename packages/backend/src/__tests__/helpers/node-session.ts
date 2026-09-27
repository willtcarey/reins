import { scheduleWork } from "../../models/node-command-projection.js";
import { claimCommand, enqueueInput, settleCommand } from "../../node-command-store.js";
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
  return enqueueInput(sessionId, "prompt", [{ type: "text", text }], clientId);
}

/** Moves a queued input through delivery to node admission, as the dispatcher would. */
export function admitInput(commandId: string, clientId: string): void {
  claimCommand(commandId);
  settleCommand(commandId, "admitted", JSON.stringify({ ok: true, value: { kind: "admitted", inputId: clientId } }));
}
