/**
 * What a handler load offers the session runtimes the process keeps (`Server`, ADR-029): its hub to
 * reach a source's node, its credential store (with its per-provider refresh lock), run lifecycle, the
 * Reins tools and the attachment store. A load hands them to the process when it starts serving
 * (`OpenSessions.serve`) and stops them when it stops: scripts it still runs are aborted, and their
 * tool calls come back "may have run".
 */
import type { AttachmentBytes, Server, ServerState } from "../state.js";
import { getNode } from "../node-store.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import { createDbCredentialStore } from "../pi/credential-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { Models } from "../models/models.js";
import { serverToolCalls, sessionToolScope } from "../tools/index.js";
import { SessionInstance } from "../sessions/session-instance.js";
import { sessionRuns } from "../sessions/session-runs.js";

/** A failure with the outcome the runtime's tools tell the model (`Server.toolCalls`). */
const failure = (message: string, outcome: "unknown" | "not_run") => Object.assign(new Error(message), { outcome });

/** This load's `Server`, and `stop`, which ends what it still runs for runtimes (its scripts). */
export function sessionServer(state: ServerState): Server & { stop(): void } {
  const runs = sessionRuns({ broadcast: createBroadcast(state.clients), state });
  const credentials = createDbCredentialStore();
  /** Scripts running for runtimes: aborted when the load stops. */
  const scripts = new Set<AbortController>();
  let stopped = false;
  return {
    node(nodeId) {
      if (getNode(nodeId)?.removedAt) throw new Error(`Node removed: ${nodeId}`);
      return state.nodes.get(nodeId);
    },
    credentials,
    runStarted: (sessionId, runId) => runs.runStarted(sessionId, runId),
    runSettled: report => runs.runSettled(report),
    toolCalls(sessionId) {
      const models = new Models(state);
      const calls = serverToolCalls({
        ...sessionToolScope(sessionId), sessionId,
        broadcast: models.broadcast, nodes: state.nodes, models, instance: new SessionInstance(state, sessionId),
      });
      return {
        async executeScript(code, signal) {
          if (stopped) throw failure("The server is reloading", "not_run");
          const controller = new AbortController();
          const abort = () => controller.abort(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          scripts.add(controller);
          try {
            const result = await calls.executeScript(code, controller.signal);
            if (stopped && !signal?.aborted) throw failure("The server reloaded while the script ran", "unknown");
            return result;
          } finally {
            scripts.delete(controller);
            signal?.removeEventListener("abort", abort);
          }
        },
        searchScript: (query, signal) => calls.searchScript(query, signal),
        createTask: (input, signal) => calls.createTask(input, signal),
      };
    },
    attachment(sessionId, attachmentId): AttachmentBytes | null {
      const row = getSessionAttachment(sessionId, attachmentId);
      return row?.data ? {
        data: row.data, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
        ...(row.filename ? { filename: row.filename } : {}),
        ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
      } : null;
    },
    storeAttachment(sessionId, attachmentId, { data, mimeType, filename, width, height }) {
      storeSessionAttachment(sessionId, { id: attachmentId, data, mimeType, filename, width, height });
    },
    stop() {
      stopped = true;
      for (const script of scripts) script.abort(new Error("The server reloaded"));
    },
  };
}
