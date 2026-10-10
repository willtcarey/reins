/**
 * Outbox delivery of session commands.
 *
 * A command is the submitted work `node_command_outbox` holds (prompt, steer, setModel): the hub's
 * dispatcher resolves each session's node through `sessionRoute` and delivers the
 * command as its node method, classifying the outcome so the outbox settles or requeues it. Abort,
 * resumePending and close are not commands: product code calls the node directly (e.g.
 * `Sessions.abort` and `Sessions.resume` in `models/sessions.ts`), sending the same session context
 * (`SessionModel.context`) when the call may open the runtime.
 */
import { APPLICATION_ERROR, nodeError, RpcFailure, type NodeCommand, type NodeResult, BUSY, UNAUTHORIZED } from "@reins/node-protocol";
import { DeliveryDeferred } from "./node-command-dispatcher.js";
import type { NodeCommandTimeouts, SessionRoute } from "./node-hub.js";
import type { RemoteNode } from "../state.js";
import { SessionNotFoundError, type Sessions } from "../models/sessions.js";
import type { SessionContext } from "../models/session.js";

// Busy/stale-epoch/unnegotiated rejections happen before the node's handler runs; lost connections and
// timeouts leave the outcome unknown.
const NOT_RUN = new Set<RpcFailure["code"]>(["unavailable", BUSY, UNAUTHORIZED]);

/**
 * Maps a delivery to the node's NodeResult: success is its value; a node rejection (`-32000` with a
 * NodeResult error as `error.data`) keeps the node's code. When the node did not run the command, or may
 * have run it (timeout, lost connection), throws DeliveryDeferred so the outbox requeues it (safe because
 * every command converges on replay; see node-contract.md). Other protocol failures (e.g. `-32602`
 * invalid params) are rethrown as terminal delivery exceptions.
 */
async function deliveryOutcome(call: () => Promise<Extract<NodeResult, { ok: true }>["value"]>): Promise<NodeResult> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof RpcFailure)) throw error;
    const rejected = error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data) : undefined;
    if (rejected?.success) return { ok: false, error: rejected.data };
    if (error.outcome !== "unknown" && !NOT_RUN.has(error.code)) throw error;
    throw new DeliveryDeferred(error.message);
  }
}

/**
 * Where the session's outbox commands go now (see `SessionRoute`): its source's node, or null when the
 * session or its source is gone. Each send builds what the command carries from the rows at send time
 * (`SessionModel.context`); one that cannot be built (e.g. an unusable `default_model`) rejects, a terminal
 * delivery failure.
 */
export function sessionRoute(sessions: Sessions, sessionId: string): SessionRoute | null {
  let session;
  try {
    session = sessions.get(sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) return null;
    throw error;
  }
  const source = session.source();
  if (!source) return null;
  return { nodeId: source.node_id, send: async (node, command, timeouts) => sendCommand(session.context(source), node, command, timeouts) };
}

/** Sends one outbox command as its node method. It carries no outbox ID: the node keeps no per-command
 * state and a replay converges on the command's own state. */
function sendCommand({ binding, branch, lane, runtime }: SessionContext, node: RemoteNode, command: NodeCommand, timeouts: NodeCommandTimeouts): Promise<NodeResult> {
  const { sessionId } = command;
  return deliveryOutcome(async () => {
    switch (command.op) {
      case "session.prompt":
      case "session.steer": {
        const input = { sessionId, binding, branch, lane, runtime, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
        return node.request(command.op, input, { timeoutMs: timeouts.input });
      }
      case "session.setModel":
        return node.request(command.op, { sessionId, binding, branch, lane, runtime, provider: command.provider, modelId: command.modelId,
          ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }) }, { timeoutMs: timeouts.setModel });
    }
  });
}
