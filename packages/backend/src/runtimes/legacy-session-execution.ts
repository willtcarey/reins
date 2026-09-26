import type { ServerState } from "../state.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import type { SessionExecutionTarget } from "./execution-target.js";
import { SessionManager } from "./session-manager.js";

/** Pre-node sessions retain server-owned runtime and canonical server SQLite. The outbox command ID is
 * unused: the in-process runtime keeps no admission receipts. */
export function legacyExecutionTarget(state: ServerState): SessionExecutionTarget {
  return { send: command => sendLegacySessionCommand(state, command) };
}

async function sendLegacySessionCommand(state: ServerState, input: NodeCommand): Promise<NodeResult> {
  if (input.op === "session.provision") return { ok: true, value: { kind: "provisioned" } };
  const { runtime } = await new SessionManager(state).open(input.sessionId);
  switch (input.op) {
    case "session.prompt":
    case "session.steer": {
      const options = { reinsId: input.clientId, ...(input.sourceSessionId ? { metadata: { sourceSessionId: input.sourceSessionId } } : {}) };
      if (input.op === "session.prompt") await runtime.prompt(input.content, options);
      else await runtime.steer(input.content, options);
      return { ok: true, value: { kind: "admitted", inputId: input.clientId } };
    }
    case "session.abort":
      await runtime.abort();
      return { ok: true, value: { kind: "aborted", aborted: true } };
    case "session.resumePending":
      if (!runtime.resumePendingOperation) throw new Error("Runtime does not support pending-operation resume");
      await runtime.resumePendingOperation();
      return { ok: true, value: { kind: "resumed", started: true } };
    case "session.setModel":
      await runtime.setModel({ provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel ?? null });
      return { ok: true, value: { kind: "modelSet" } };
  }
}
