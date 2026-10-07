/**
 * Outbox delivery of session commands, and what a session's runtime is opened with.
 *
 * A command is the submitted work `node_command_outbox` holds (prompt, steer, setModel): the hub's
 * dispatcher resolves each session's node through `sessionRoute` and delivers the
 * command as its node method, classifying the outcome so the outbox settles or requeues it. Abort,
 * resumePending and close are not commands: product code calls the node directly (e.g.
 * `Sessions.abort` and `Sessions.resume` in `models/sessions.ts`), sending the same session context
 * (`sessionContext`) when the call may open the runtime.
 */
import { APPLICATION_ERROR, nodeError, RpcFailure, type NodeCommand, type NodeResult, BUSY, UNAUTHORIZED, type LaneSeed, type NodeSessionBinding, type SessionRuntime } from "@reins/node-protocol";
import { DeliveryDeferred } from "./node-command-dispatcher.js";
import type { NodeCommandTimeouts, SessionRoute } from "./node-hub.js";
import type { RemoteNode } from "../state.js";
import { sessionSource } from "../models/sources.js";
import { piModelSetting } from "../models/model-settings.js";
import type { Source } from "../node-store.js";
import { getSession, type SessionRow } from "../session-store.js";
import { getTask } from "../task-store.js";
import { sessionKind } from "../sessions/session-kinds.js";

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
 * (`sessionContext`); one that cannot be built (e.g. an unusable `default_model`) rejects, a terminal
 * delivery failure.
 */
export function sessionRoute(sessionId: string): SessionRoute | null {
  const row = getSession(sessionId);
  const source = row && sessionSource(row);
  if (!source) return null;
  return { nodeId: source.node_id, send: async (node, command, timeouts) => sendCommand(sessionContext(row, source), node, command, timeouts) };
}

/** The node binding every session call carries: where the session runs (its source's checkout) and
 * the identity Pi's session is created with. Product identity and path resolution stay server-side. */
export function sessionBinding(row: SessionRow, source: Source): NodeSessionBinding {
  return { sourceId: source.id, cwd: source.path, createdAt: row.created_at, parentSessionId: row.parent_session_id };
}

/** The session's context as its node needs it to run the session, carried by every call that may open
 * its runtime (its outbox commands, `session.resumePending`): the binding, the lane seed, and what the
 * session's kind resolves, the runtime
 * configuration (with the server's system prompt) and the branch the node checks out first (null:
 * none). Built from the rows at send time, so task and prompt edits reach the node the next time it
 * opens the runtime; throws when the lane seed cannot be built (an unusable `default_model`) or the
 * session's kind is unknown. No server DB handle reaches node code. */
export interface SessionContext { binding: NodeSessionBinding; branch: string | null; lane: LaneSeed; runtime: SessionRuntime }
export function sessionContext(row: SessionRow, source: Source): SessionContext {
  const task = row.task_id === null ? null : getTask(row.task_id);
  const { branch = null, ...runtime } = sessionKind(row.kind)({ session: row, task });
  return { binding: sessionBinding(row, source), branch, lane: laneSeed(row), runtime };
}

/** A stored thinking level as the wire carries it: `off` is null. */
const thinking = (level: string | null) => level && level !== "off" ? level : null;

/** The model Pi's main lane starts with if the session has none yet (the node seeds it when it opens the
 * runtime): the row's, else the current `default_model` setting's (with its thinking level); a null model
 * when neither resolves. The server does not validate it: the node's model registry does. */
function laneSeed(row: SessionRow): LaneSeed {
  if (row.model_provider && row.model_id) return { model: { provider: row.model_provider, modelId: row.model_id }, thinkingLevel: thinking(row.thinking_level) };
  const defaultModel = piModelSetting("default_model");
  if (!defaultModel) return { model: null, thinkingLevel: null };
  return { model: { provider: defaultModel.provider, modelId: defaultModel.modelId }, thinkingLevel: thinking(defaultModel.thinkingLevel) };
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
