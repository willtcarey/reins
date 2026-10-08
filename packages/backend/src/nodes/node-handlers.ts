import { APPLICATION_ERROR, RpcFailure, type NodeError, type StoredAttachment } from "@reins/node-protocol";
import type { ServerState } from "../state.js";
import type { ServerHandlers } from "./server-peer.js";
import { getSession } from "../session-store.js";
import { getNodeDetails } from "../node-store.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import { nodeOwnsSession } from "../sessions/session-ownership.js";
import { nodeSessionReports, type NodeSessionReports } from "./node-session-events.js";
import { nodeToolCalls, type NodeToolCalls } from "./node-tool-calls.js";
import { createNodeCredentialService, type NodeCredentialService } from "./node-credentials.js";
import { commitStorage, readStorage } from "./node-storage.js";

/** The handlers serving node→server calls, for one hub: given the node ID a connection announced in
 * `node.hello`, that node's handlers (`nodeServerHandlers`); throws for a node with no `nodes` row or a
 * revoked one, which refuses its hello (on every connection, whatever its transport). */
export function nodeHandlers(state: ServerState): (nodeId: string) => ServerHandlers {
  const products: Products = { reports: nodeSessionReports(state), tools: nodeToolCalls(state), credentials: createNodeCredentialService() };
  return nodeId => {
    const node = getNodeDetails(nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    if (node.revokedAt) throw new Error(`Node revoked: ${nodeId}`);
    return nodeServerHandlers(nodeId, products);
  };
}

/** The product modules every link of one hub is served by. */
interface Products { reports: NodeSessionReports; tools: NodeToolCalls; credentials: NodeCredentialService }

/**
 * Node→server calls from node `nodeId` (the ID its connection announced in `node.hello`) run only here,
 * as protocol handlers. Fencing (ADR-015): every call about a session is served only for a session whose
 * source is on this node, so a node the session was moved away from can neither read nor write it; the
 * rejection is definite (`not_owner` as the error data). Unknown sessions are rejected before any product
 * code runs. Credentials are not per session: any negotiated connection is served.
 */
function nodeServerHandlers(nodeId: string, { reports, tools, credentials }: Products): ServerHandlers {
  const owned = (sessionId: string) => {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    if (!nodeOwnsSession(sessionId, nodeId)) {
      const message = `Node session unavailable: ${sessionId}`;
      throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "not_owner", message, retryable: false } satisfies NodeError);
    }
    return row;
  };
  return {
    readCredential: providerId => credentials.readCredential(providerId),
    refreshCredential: providerId => credentials.refreshCredential(providerId),
    listCredentials: () => credentials.listCredentials(),
    started: input => { owned(input.sessionId); return reports.started(input); },
    settled: input => { owned(input.sessionId); return reports.settled(input); },
    attachment: (sessionId, attachmentId) => {
      owned(sessionId);
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
    storageRead: async input => { owned(input.sessionId); return readStorage(input); },
    storageCommit: async input => { owned(input.sessionId); return commitStorage(input); },
    // One read of the session row per live event serves both fencing and the browser frame's project.
    event: input => reports.event({ ...input, projectId: owned(input.sessionId).project_id }),
    // Tool calls carry only the session ID; tools derive project/task scope from the server's row.
    scriptExecute: async (input, signal) => { owned(input.sessionId); return tools.scriptExecute(input, signal); },
    scriptSearch: input => { owned(input.sessionId); return tools.scriptSearch(input); },
    createTask: async input => { owned(input.sessionId); return tools.createTask(input); },
  };
}
