import type { ServerState } from "../state.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import type { SessionExecutionTarget } from "./execution-target.js";
import { SessionManager } from "./session-manager.js";
import { hydrateForDelivery, hydrateSession } from "./session-relocation.js";

/**
 * Sessions at rest on the server (legacy `storage_owner = "server"`) no longer run on the server: work
 * that needs a runtime first hydrates the session onto its node, then is delivered there through the
 * node target. Normally the hydrate is already queued ahead of the work (see `queueHydrationForUse`); this
 * covers work that reaches the target without one (a hydrate interrupted by a restart, work queued before
 * this path existed). Provision needs nothing on the server; abort has nothing to stop unless a legacy
 * runtime is still live in this process.
 */
export function legacyExecutionTarget(state: ServerState, node: SessionExecutionTarget): SessionExecutionTarget {
  return {
    async send(command, commandId) {
      switch (command.op) {
        case "session.provision": return { ok: true, value: { kind: "provisioned" } };
        case "session.hydrate":
          if (!commandId) throw new Error("session.hydrate requires an outbox command ID");
          return hydrateSession(state, command.sessionId, commandId, command.targetSourceId);
        case "session.release":
          return { ok: false, error: { code: "invalid_request", message: "Session is already at rest on the server", retryable: false } };
        case "session.abort": {
          const managed = state.sessions.get(command.sessionId);
          const busy = managed?.runtime.isStreaming() ?? false;
          if (managed) await managed.runtime.abort();
          return { ok: true, value: { kind: "aborted", aborted: busy } };
        }
        default: {
          const hydrated = await hydrateForDelivery(state, command.sessionId);
          return hydrated.ok ? node.send(command, commandId) : hydrated;
        }
      }
    },
  };
}

/**
 * The retired server-side execution of legacy sessions (an in-process runtime over server SQLite). No
 * longer called: sessions at rest on the server are hydrated onto their node before they run. Kept until
 * the legacy execution code is deleted.
 */
export async function sendLegacySessionCommand(state: ServerState, input: NodeCommand): Promise<NodeResult> {
  if (input.op === "session.provision") return { ok: true, value: { kind: "provisioned" } };
  if (input.op === "session.hydrate" || input.op === "session.release") return { ok: false, error: { code: "unsupported", message: `${input.op} is not a legacy command`, retryable: false } };
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
