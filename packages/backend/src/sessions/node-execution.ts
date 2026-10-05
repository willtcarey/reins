import type { NodeHub } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { enqueueInput, enqueueSetModel } from "../node-link/node-command-store.js";
import { requireSessionSource } from "../models/sources.js";

/** Work queued for a session's node in the command outbox: input (deduplicated by `clientId`) or a model
 * change. `sourceSessionId`: the session an addressed steer comes from. */
export type SessionSubmission =
  | { op: "prompt" | "steer"; content: ClientPromptContent; clientId: string; sourceSessionId?: string }
  | { op: "setModel"; provider: string; modelId: string; thinkingLevel?: string };

/**
 * Queues `command` behind the session's earlier work and wakes delivery. Validates the session's current
 * source first (throws when it is unavailable, queueing nothing). The insert is synchronous, so a caller
 * may submit inside its own transaction; the wake is a microtask, so it runs once that transaction has
 * committed (after a rollback it finds nothing new). A replay of admitted input queues nothing. Work for
 * a node that is not connected waits in the outbox.
 */
export function submit(nodes: Pick<NodeHub, "wake">, sessionId: string, command: SessionSubmission): void {
  requireSessionSource(sessionId);
  if (command.op === "setModel") enqueueSetModel(sessionId, command);
  else enqueueInput(sessionId, command.op, command.content, command.clientId, command.sourceSessionId);
  queueMicrotask(() => void nodes.wake());
}
