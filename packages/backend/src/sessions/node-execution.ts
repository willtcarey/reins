import { BUSY, RpcFailure, UNAUTHORIZED, type NodeError } from "@reins/node-protocol";
import type { NodeHub } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { enqueueInput, enqueueSetModel } from "../node-link/node-command-store.js";
import { requireSessionSource, resolveSource } from "../models/sources.js";
import { getSession } from "../session-store.js";
import { nodeRefusal } from "../errors.js";
import { sessionContext, sessionBinding } from "../nodes/commands.js";

/** Work queued for a session's node in the command outbox: input (deduplicated by `clientId`) or a model
 * change. `sourceSessionId`: the session an addressed steer comes from. */
export type SessionSubmission =
  | { op: "prompt" | "steer"; content: ClientPromptContent; clientId: string; sourceSessionId?: string }
  | { op: "setModel"; provider: string; modelId: string; thinkingLevel?: string };

/** Immediate controls: sent to the session's node at once, never queued. */
export type SessionControl = "abort" | "resumePending";

/** Bounds (ms) on the node answering a control: abort waits for the aborted run to go idle; resuming
 * may open the runtime first. Not on the resumed run. */
const CONTROL_TIMEOUTS_MS: Record<SessionControl, number> = { abort: 30_000, resumePending: 60_000 };

/** A control the node did not carry out: its refusal (`error` is the node's NodeError), or `unavailable`
 * when it was not connected, did not answer in time or its link dropped. */
export class ControlFailed extends Error {
  constructor(readonly error: NodeError) {
    super(error.message);
    this.name = "ControlFailed";
  }
}

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

/**
 * Calls an immediate control on the session's current node and returns its answer (`{aborted}`,
 * `{started}`). Abort carries the session's binding; resuming may open the runtime, so it carries the
 * session context outbox commands do. Throws `ControlFailed` when the node refuses it or cannot be
 * reached (never queued or retried); throws when the session or its source is gone.
 */
export async function control(nodes: Pick<NodeHub, "get">, sessionId: string, command: SessionControl): Promise<{ aborted: boolean } | { started: boolean }> {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = resolveSource(row.project_id, row.source_id);
  const node = nodes.get(source.node_id);
  const timeoutMs = CONTROL_TIMEOUTS_MS[command];
  try {
    return command === "abort"
      ? await node.request("session.abort", { sessionId, binding: sessionBinding(row, source) }, { timeoutMs })
      : await node.request("session.resumePending", { sessionId, ...sessionContext(row, source) }, { timeoutMs });
  } catch (error) {
    const refusal = nodeRefusal(error);
    if (refusal) throw new ControlFailed(refusal);
    // Not sent, refused before the node's handler ran (busy, stale epoch) or outcome unknown.
    if (error instanceof RpcFailure && (error.code === "unavailable" || error.code === BUSY || error.code === UNAUTHORIZED)) {
      throw new ControlFailed({ code: "unavailable", message: `Node unavailable: ${error.message}`, retryable: true });
    }
    throw error;
  }
}
