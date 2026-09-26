import type { ServerState } from "../state.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { ensureSessionOpen } from "./session-manager.js";

/** Pre-node sessions retain server-owned runtime and canonical server SQLite. */
export async function sendLegacySessionCommand(state: ServerState, input: NodeCommand): Promise<NodeResult> {
  if (input.op === "session.provision") return { ok: true, value: { kind: "provisioned" } };
  const { runtime } = await ensureSessionOpen(state, input.sessionId);
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
  }
}
