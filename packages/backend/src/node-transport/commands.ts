import { APPLICATION_ERROR, nodeError, RpcFailure, DeliveryDeferred, deliveryPolicy, type NodeCommand, type NodeResult } from "@reins/node-protocol";
import type { NodeCommandClient, NodeLinks } from "../runtimes/node-hub.js";
import { sessionTarget } from "../runtimes/node-source.js";

// Busy/stale-epoch/unnegotiated rejections happen before the node's handler runs; lost connections and
// timeouts leave the outcome unknown.
const NOT_RUN = new Set<RpcFailure["code"]>(["unavailable", -32002, -32003]);

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
function linked(client: NodeCommandClient | undefined): NodeCommandClient {
  if (!client) throw new RpcFailure("unavailable", "Node not connected");
  return client;
}

/**
 * Sends one semantic command over the node's link (`undefined` when it has none). Submitted work carries
 * no outbox ID: the node keeps no per-command state and a replay converges on the command's own state.
 */
export function deliverToNode(links: NodeLinks, command: NodeCommand): Promise<NodeResult> {
  const { sessionId } = command;
  const { nodeId, binding, task, lane } = sessionTarget(sessionId);
  const link = links.link(nodeId);
  const timeouts = links.timeouts;
  return commandOutcome(deliveryPolicy(command) === "submit-work", async () => {
    const client = linked(link);
    switch (command.op) {
      case "session.prompt":
      case "session.steer": {
        const input = { sessionId, binding, task, lane, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
        return command.op === "session.prompt" ? client.prompt(input, timeouts.input) : client.steer(input, timeouts.input);
      }
      case "session.setModel":
        return client.setModel({ sessionId, binding, task, lane, provider: command.provider, modelId: command.modelId,
          ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }) }, timeouts.setModel);
      case "session.abort":
        return client.abort({ sessionId, binding }, timeouts.abort);
      case "session.resumePending":
        return client.resumePending({ sessionId, binding, task, lane }, timeouts.resumePending);
    }
  });
}
