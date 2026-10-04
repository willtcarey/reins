import { APPLICATION_ERROR, nodeError, RpcFailure, DeliveryDeferred, deliveryPolicy, type NodeCommand, type NodeResult, BUSY, UNAUTHORIZED, type LaneSeed, type NodeSessionBinding, type SessionRuntime } from "@reins/node-protocol";
import type { NodeLink, SessionRoute } from "../node-link/node-hub.js";
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
  const source = row && sessionSource(row);
  if (!source) return null;
  return { nodeId: source.node_id, send: async (link, command) => sendCommand(commandTarget(row, source), link, command) };
}

/** What the session's commands carry to its node: the node binding for its source and what an opening
 * command carries: the lane seed, and what the session's kind resolves, the runtime configuration (with
 * the server's system prompt) and the branch the node checks out first (null: none). Built from the rows at
 * send time, so task and prompt edits reach the node the next time it opens the runtime; throws when the
 * lane seed cannot be built (an unusable `default_model`) or the session's kind is unknown. Product
 * identity and path resolution stay server-side; no server DB handle reaches node code. */
export interface CommandTarget { binding: NodeSessionBinding; branch: string | null; lane: LaneSeed; runtime: SessionRuntime }
export function commandTarget(row: SessionRow, source: Source): CommandTarget {
  const task = row.task_id === null ? null : getTask(row.task_id);
  const { branch = null, ...runtime } = sessionKind(row.kind)({ session: row, task });
  return {
    binding: { sourceId: source.id, cwd: source.path, createdAt: row.created_at, parentSessionId: row.parent_session_id },
    branch,
    lane: laneSeed(row),
    runtime,
  };
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

/** Sends one semantic command over the node's link. Submitted work carries no outbox ID: the node keeps
 * no per-command state and a replay converges on the command's own state. */
function sendCommand({ binding, branch, lane, runtime }: CommandTarget, link: NodeLink | undefined, command: NodeCommand): Promise<NodeResult> {
  const { sessionId } = command;
  return commandOutcome(deliveryPolicy(command) === "submit-work", async () => {
    const { client, timeouts } = linked(link);
    switch (command.op) {
      case "session.prompt":
      case "session.steer": {
        const input = { sessionId, binding, branch, lane, runtime, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
        return client.call(command.op, input, { timeoutMs: timeouts.input });
      }
      case "session.setModel":
        return client.call(command.op, { sessionId, binding, branch, lane, runtime, provider: command.provider, modelId: command.modelId,
          ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }) }, { timeoutMs: timeouts.setModel });
      case "session.abort":
        return client.call(command.op, { sessionId, binding }, { timeoutMs: timeouts.abort });
      case "session.resumePending":
        return client.call(command.op, { sessionId, binding, branch, lane, runtime }, { timeoutMs: timeouts.resumePending });
    }
  });
}
