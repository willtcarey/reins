import type { ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import { waitForAdmission, wakeOpenForInput } from "../models/node-command-dispatcher.js";
import { internalNodeFor, provisionForSession } from "./internal-node.js";
import { sendLegacySessionCommand } from "./legacy-session-execution.js";
import { enqueueInput } from "../node-command-store.js";

/** Session commands resolve the current source before entering host execution. */
export async function executeSessionCommand(
  state: ServerState,
  sessionId: string,
  command: "prompt" | "steer" | "abort" | "resumePending",
  content?: ClientPromptContent,
  clientId?: string,
  sourceSessionId?: string,
): Promise<void> {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id) throw new Error(`Execution source unavailable for session ${sessionId}`);
  if (source.node_id !== "internal") throw new Error(`Execution source unavailable for source ${source.id}`);
  if (command === "prompt" || command === "steer") {
    if (!content || !clientId) throw new Error("Input requires content and clientId");
    enqueueInput(sessionId, command, content, clientId, sourceSessionId);
    wakeOpenForInput(state);
    return;
  }
  await waitForAdmission(state, sessionId);
  const input = { op: command === "abort" ? "session.abort" as const : "session.resumePending" as const, sessionId };
  const result = row.storage_owner === "internal-node"
    ? await internalNodeFor(state).send(input, provisionForSession(sessionId).binding)
    : await sendLegacySessionCommand(state, input);
  if (!result.ok) throw new Error(result.error.message);
}
