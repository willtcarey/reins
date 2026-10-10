import { APPLICATION_ERROR, NODE_REFUSED, RpcFailure, type NodeError, type StoredAttachment } from "@reins/node-protocol";
import type { ServerState } from "../state.js";
import type { ServerHandlers } from "./server-peer.js";
import { NodeNotFoundError, type Nodes } from "../models/nodes.js";
import { NodeRevokedError } from "../models/node.js";
import type { Sessions } from "../models/sessions.js";
import type { SessionModel } from "../models/session.js";
import { nodeOwnsSession } from "../sessions/session-ownership.js";
import { nodeSessionReports, type NodeSessionReports } from "./node-session-events.js";
import { nodeToolCalls, type NodeToolCalls } from "./node-tool-calls.js";
import { createNodeCredentialService, type NodeCredentialService } from "./node-credentials.js";
import { commitStorage, readStorage } from "./node-storage.js";

/** The handlers serving node→server calls, for one hub (`nodes` and `sessions` are its models): given the
 * node ID a connection announced in `node.hello`, that node's handlers (`nodeServerHandlers`). An unknown
 * node (`NodeNotFoundError`) or a revoked one (`NodeRevokedError`) throws `NODE_REFUSED` with its message,
 * which refuses its hello (on every connection, whatever its transport) and stops the node redialing. */
export function nodeHandlers(state: ServerState, nodes: Nodes, sessions: Sessions): (nodeId: string) => ServerHandlers {
  const products: Products = { sessions, reports: nodeSessionReports(state), tools: nodeToolCalls(state), credentials: createNodeCredentialService() };
  return nodeId => {
    try {
      nodes.get(nodeId).assertMayConnect();
    } catch (error) {
      if (error instanceof NodeNotFoundError || error instanceof NodeRevokedError) throw new RpcFailure(NODE_REFUSED, error.message);
      throw error;
    }
    return nodeServerHandlers(nodeId, products);
  };
}

/** The product modules every link of one hub is served by. */
interface Products { sessions: Sessions; reports: NodeSessionReports; tools: NodeToolCalls; credentials: NodeCredentialService }

/**
 * Node→server calls from node `nodeId` (the ID its connection announced in `node.hello`) run only here,
 * as protocol handlers. Fencing (ADR-015): every call about a session is served only for a session whose
 * source is on this node, so a node the session was moved away from can neither read nor write it; the
 * rejection is definite (`not_owner` as the error data). Unknown sessions are rejected before any product
 * code runs. Credentials are not per session: any negotiated connection is served.
 */
function nodeServerHandlers(nodeId: string, { sessions, reports, tools, credentials }: Products): ServerHandlers {
  const owned = (sessionId: string): SessionModel => {
    const session = sessions.get(sessionId);
    if (!nodeOwnsSession(sessionId, nodeId)) {
      const message = `Node session unavailable: ${sessionId}`;
      throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "not_owner", message, retryable: false } satisfies NodeError);
    }
    return session;
  };
  return {
    readCredential: providerId => credentials.readCredential(providerId),
    refreshCredential: providerId => credentials.refreshCredential(providerId),
    listCredentials: () => credentials.listCredentials(),
    started: input => { owned(input.sessionId); return reports.started(input); },
    settled: input => { owned(input.sessionId); return reports.settled(input); },
    attachment: (sessionId, attachmentId) => {
      const row = owned(sessionId).attachment(attachmentId);
      return row?.data ? { data: row.data, mimeType: row.mime_type, byteSize: row.byte_size,
        sha256: row.sha256, filename: row.filename ?? undefined,
        width: row.width ?? undefined, height: row.height ?? undefined } : null;
    },
    findAttachment: (sessionId, attachmentId): StoredAttachment | null => {
      const row = owned(sessionId).attachment(attachmentId);
      return row?.data ? { attachmentId: row.id, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256 } : null;
    },
    // Stored under the node-assigned ID (see `SessionModel.storeAttachment`).
    storeAttachment: (sessionId, attachmentId, { data, mimeType, filename, width, height }) => {
      owned(sessionId).storeAttachment({ id: attachmentId, data, mimeType, filename, width, height });
    },
    storageRead: async input => readStorage(owned(input.sessionId), input),
    storageCommit: async input => commitStorage(owned(input.sessionId), input),
    // One read of the session row per live event serves both fencing and the browser frame's project.
    event: input => reports.event({ ...input, projectId: owned(input.sessionId).projectId }),
    // Tool calls carry only the session ID; tools derive project/task scope from the server's row.
    scriptExecute: async (input, signal) => { owned(input.sessionId); return tools.scriptExecute(input, signal); },
    scriptSearch: input => { owned(input.sessionId); return tools.scriptSearch(input); },
    createTask: async input => { owned(input.sessionId); return tools.createTask(input); },
  };
}
