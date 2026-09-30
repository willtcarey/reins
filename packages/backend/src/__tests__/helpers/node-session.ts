import { claimCommand, enqueueInput, getCommand, settleCommand } from "../../node-link/node-command-store.js";
import { persistCanonicalMessages } from "./canonical-messages.js";
import { selectCreationSource } from "../../sessions/node-source.js";
import { createSession } from "../session-fixture.js";

/** A session on its project's default source's node. Server projections only: no node runtime is
 * involved, as if the node ran in another process. */
export function createNodeSession(
  id: string,
  projectId: number,
  opts: { taskId?: number; parentSessionId?: string } = {},
): void {
  createSession(id, projectId, { agentRuntimeType: "pi", ...opts, sourceId: selectCreationSource(projectId).id });
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
