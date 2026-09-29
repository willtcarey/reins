import type { NodeCommand, NodeResult } from "@reins/node-protocol";
import type { ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { enqueueInput } from "../node-command-store.js";
import { sendNodeCommand, type NodeLinks } from "../node-transport/commands.js";
import { requireSessionSource, sessionTarget } from "./node-source.js";

/**
 * Delivers one command to the node of the session's source over that node's link (a node without an
 * open link: submitted work is deferred, a control is `unavailable`), with the binding, task snapshot and
 * lane seed resolved from product rows (the node creates Pi's main lane from the seed when the session
 * has none).
 */
export async function deliverToNode(links: NodeLinks, command: NodeCommand): Promise<NodeResult> {
  const { nodeId, ...target } = sessionTarget(command.sessionId);
  return sendNodeCommand(links.link(nodeId), command, target, links.timeouts);
}

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
