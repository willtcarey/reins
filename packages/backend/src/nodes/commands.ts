import { APPLICATION_ERROR, nodeError, RpcFailure, DeliveryDeferred, deliveryPolicy, type NodeCommand, type NodeResult, BUSY, UNAUTHORIZED } from "@reins/node-protocol";
import type { NodeLink, SessionRoute } from "../node-link/node-hub.js";
import { commandTarget, resolveSessionSource, type CommandTarget } from "../sessions/node-source.js";
import { getSession } from "../session-store.js";

// Busy/stale-epoch/unnegotiated rejections happen before the node's handler runs; lost connections and
// timeouts leave the outcome unknown.
const NOT_RUN = new Set<RpcFailure["code"]>(["unavailable", BUSY, UNAUTHORIZED]);

/**
 * Maps a wire command to the node's NodeResult: success is its value; a node rejection (`-32000` with a
 * NodeResult error as `error.data`) keeps the node's code. When the node did not run the command, or may
 * have run it (timeout, lost connection): `replayable` work throws DeliveryDeferred so the outbox
 * requeues it (safe because every submitted op converges on replay; see node-contract.md), and an
 * immediate control returns `unavailable` to its caller, never retried. Other protocol failures
 * (e.g. `-32602` invalid params) are rethrown as terminal delivery exceptions.
 */
async function commandOutcome(replayable: boolean, call: () => Promise<Extract<NodeResult, { ok: true }>["value"]>): Promise<NodeResult> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof RpcFailure)) throw error;
    const rejected = error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data) : undefined;
    if (rejected?.success) return { ok: false, error: rejected.data };
    if (error.outcome !== "unknown" && !NOT_RUN.has(error.code)) throw error;
    if (replayable) throw new DeliveryDeferred(error.message);
    return { ok: false, error: { code: "unavailable", message: `Node unavailable: ${error.message}`, retryable: true } };
  }
}

/** The node's link is not open: nothing was sent (submitted work is deferred, a control is `unavailable`). */
function linked(link: NodeLink | undefined): NodeLink {
  if (!link) throw new RpcFailure("unavailable", "Node not connected");
  return link;
}

/**
 * Where the session's commands go now (see `SessionRoute`): its source's node, or null when the session
 * or its source is gone. Each send builds what the command carries from the rows at send time
 * (`commandTarget`); one that cannot be built (e.g. an unusable `default_model`) rejects, a terminal
 * delivery failure.
 */
export function sessionRoute(sessionId: string): SessionRoute | null {
  const row = getSession(sessionId);
  const resolved = row && resolveSessionSource(row);
  if (!resolved) return null;
  return { nodeId: resolved.nodeId, send: async (link, command) => sendCommand(commandTarget(row, resolved.source), link, command) };
}

/** Sends one semantic command over the node's link. Submitted work carries no outbox ID: the node keeps
 * no per-command state and a replay converges on the command's own state. */
function sendCommand({ binding, task, lane }: CommandTarget, link: NodeLink | undefined, command: NodeCommand): Promise<NodeResult> {
  const { sessionId } = command;
  return commandOutcome(deliveryPolicy(command) === "submit-work", async () => {
    const { client, timeouts } = linked(link);
    switch (command.op) {
      case "session.prompt":
      case "session.steer": {
        const input = { sessionId, binding, task, lane, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
        return client.call(command.op, input, { timeoutMs: timeouts.input });
      }
      case "session.setModel":
        return client.call(command.op, { sessionId, binding, task, lane, provider: command.provider, modelId: command.modelId,
          ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }) }, { timeoutMs: timeouts.setModel });
      case "session.abort":
        return client.call(command.op, { sessionId, binding }, { timeoutMs: timeouts.abort });
      case "session.resumePending":
        return client.call(command.op, { sessionId, binding, task, lane }, { timeoutMs: timeouts.resumePending });
    }
  });
}
