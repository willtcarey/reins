import type { ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { enqueueInput } from "../node-command-store.js";
import { requireSessionSource } from "./node-source.js";

/** Validates the session's current source and persists input synchronously, so a caller can enqueue
 * inside its own transaction; wake the hub after that transaction commits. Input for a node that is not
 * connected waits in the outbox. */
export function enqueueSessionInput(sessionId: string, command: "prompt" | "steer", content: ClientPromptContent, clientId: string, sourceSessionId?: string): void {
  requireSessionSource(sessionId);
  enqueueInput(sessionId, command, content, clientId, sourceSessionId);
}

/** Session commands resolve the current source first. Input is queued in the outbox; immediate
 * controls go to the session's node at once. */
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
    void state.nodes.wake();
    return;
  }
  requireSessionSource(sessionId);
  const input = { op: command === "abort" ? "session.abort" as const : "session.resumePending" as const, sessionId };
  const result = await state.nodes.send(input);
  if (!result.ok) throw new Error(result.error.message);
}
