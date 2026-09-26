import type { ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import { waitForAdmission, wakeOpenForInput } from "../models/node-command-dispatcher.js";
import { executionTargetFor } from "./execution-target.js";
import { enqueueInput } from "../node-command-store.js";

/** Resolves the session's current source and persists input synchronously, so a caller can enqueue
 * inside its own transaction. Call `wakeSessionInput` after that transaction commits. */
export function enqueueSessionInput(sessionId: string, command: "prompt" | "steer", content: ClientPromptContent, clientId: string, sourceSessionId?: string): void {
  currentSource(sessionId);
  enqueueInput(sessionId, command, content, clientId, sourceSessionId);
}
export function wakeSessionInput(state: ServerState): void { wakeOpenForInput(state); }

function currentSource(sessionId: string) {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id) throw new Error(`Execution source unavailable for session ${sessionId}`);
  if (source.node_id !== "internal") throw new Error(`Execution source unavailable for source ${source.id}`);
  return row;
}

/** Session commands resolve the current source before entering host execution. */
export async function executeSessionCommand(
  state: ServerState,
  sessionId: string,
  command: "prompt" | "steer" | "abort" | "resumePending",
  content?: ClientPromptContent,
  clientId?: string,
  sourceSessionId?: string,
): Promise<void> {
  if (command === "prompt" || command === "steer") {
    if (!content || !clientId) throw new Error("Input requires content and clientId");
    enqueueSessionInput(sessionId, command, content, clientId, sourceSessionId);
    wakeOpenForInput(state);
    return;
  }
  const row = currentSource(sessionId);
  await waitForAdmission(state, sessionId);
  const input = { op: command === "abort" ? "session.abort" as const : "session.resumePending" as const, sessionId };
  const result = await executionTargetFor(state, row).send(input);
  if (!result.ok) throw new Error(result.error.message);
}
