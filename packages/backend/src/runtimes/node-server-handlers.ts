import { APPLICATION_ERROR, RpcFailure, type NodeError, type StoredAttachment } from "@reins/node-protocol";
import { piSnapshotSummary, readPiSnapshotPage } from "@reins/pi-sql-storage";
import type { NodeSessionEvent, ServerHandlers } from "../node-transport/server-peer.js";
import { getDb } from "../db.js";
import { getSession, type SessionRow } from "../session-store.js";
import { applyNodeReplica } from "../node-replica.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import { nodeMayReadSession, nodeOwnsSession } from "../models/session-ownership.js";
import type { NodeCredentialService } from "./node-credentials.js";

/** `event` also receives the session's project, read while fencing it. */
export interface NodeSessionReports extends Pick<ServerHandlers, "started" | "settled"> {
  event(input: NodeSessionEvent & { projectId: number }): void;
}
export type NodeToolCalls = Pick<ServerHandlers, "scriptExecute" | "scriptSearch" | "createTask">;
/** Server-side product services the node hub is created with (`installNodeHub`), so these handlers
 * import no session runtime modules. */
export type NodeServerServices = NodeSessionReports & NodeToolCalls & NodeCredentialService;

/**
 * Node→server calls from node `nodeId` (the ID its connection announced in `node.hello`) run only here,
 * as protocol handlers. Fencing: reports, uploads and tool calls are accepted only for sessions placed
 * on this node, so a node the session was moved away from (or one still hydrating it) cannot write to
 * it; the rejection is definite (`not_owner` as the error data): the node drops what it cannot deliver.
 * Reads are also open while the session is at rest on the server or moving and this node is its
 * destination. Unknown sessions are rejected before any product service runs. Credentials are not per
 * session: any negotiated connection is served.
 */
export function nodeServerHandlers(nodeId: string, services: NodeServerServices): ServerHandlers {
  const owned = (sessionId: string): SessionRow => {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    if (!nodeOwnsSession(row, nodeId)) {
      const message = `Node session unavailable: ${sessionId}`;
      throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "not_owner", message, retryable: false } satisfies NodeError);
    }
    return row;
  };
  const readable = (sessionId: string) => {
    if (!getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    if (!nodeMayReadSession(sessionId, nodeId)) throw new Error(`Node session unavailable: ${sessionId}`);
  };
  return {
    readCredential: providerId => services.readCredential(providerId),
    refreshCredential: providerId => services.refreshCredential(providerId),
    listCredentials: () => services.listCredentials(),
    committed: ({ sessionId, startSeq, writesJson }) => {
      owned(sessionId);
      applyNodeReplica(getDb(), sessionId, startSeq, writesJson);
    },
    started: input => { owned(input.sessionId); return services.started(input); },
    settled: input => { owned(input.sessionId); return services.settled(input); },
    attachment: (sessionId, attachmentId) => {
      readable(sessionId);
      const row = getSessionAttachment(sessionId, attachmentId);
      return row?.data ? { data: row.data, mimeType: row.mime_type, byteSize: row.byte_size,
        sha256: row.sha256, filename: row.filename ?? undefined,
        width: row.width ?? undefined, height: row.height ?? undefined } : null;
    },
    findAttachment: (sessionId, attachmentId): StoredAttachment | null => {
      owned(sessionId);
      const row = getSessionAttachment(sessionId, attachmentId);
      return row?.data ? { attachmentId: row.id, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256 } : null;
    },
    // Stored under the node-assigned ID; the session attachment store enforces the MIME allowlist and size
    // limit and rejects an ID held with different content or by another session.
    storeAttachment: (sessionId, attachmentId, { data, mimeType, filename, width, height }) => {
      owned(sessionId);
      storeSessionAttachment(sessionId, { id: attachmentId, data, mimeType, filename, width, height });
    },
    // A page of the server's copy with the copy's current summary, which a hydrating node pulls.
    snapshot: (sessionId, fromSeq) => {
      readable(sessionId);
      return { summary: piSnapshotSummary(getDb(), sessionId), ...readPiSnapshotPage(getDb(), sessionId, fromSeq) };
    },
    // One read of the session row per live event serves both fencing and the browser frame's project.
    event: input => services.event({ ...input, projectId: owned(input.sessionId).project_id }),
    // Tool calls carry only the session ID; the services derive project/task scope from the server's row.
    scriptExecute: async (input, signal) => { owned(input.sessionId); return services.scriptExecute(input, signal); },
    scriptSearch: input => { owned(input.sessionId); return services.scriptSearch(input); },
    createTask: async input => { owned(input.sessionId); return services.createTask(input); },
  };
}
