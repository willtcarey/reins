import { APPLICATION_ERROR, LOCAL_LINK, RpcFailure, type LinkOptions, type NodeError, type WireSocket } from "@reins/node/protocol";
import { createServerTransport, type ServerHandlers } from "../node-transport/server-peer.js";
import { NODE_COMMAND_TIMEOUTS, sendNodeCommand, sendRelocationCommand, type HydrationPayload, type NodeCommandClient, type NodeCommandTimeouts } from "../node-transport/commands.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import type { NodeSessionBinding } from "@reins/node/storage";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import type { ServerState } from "../state.js";
import { applyNodeReplica } from "../node-replica.js";
import { createNodeCredentialService } from "./node-credentials.js";
import { wakeScheduledCommands } from "../models/node-command-projection.js";
import { logger } from "../logger.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import type { StoredAttachment } from "@reins/node/protocol";
import { piSnapshotSummary, readPiSnapshotPage } from "@reins/node/pi-storage";
import { nodeMayReadSession, nodeOwnsSession } from "../models/session-ownership.js";

/** The node ID of the internal node's link: every node→server call on it acts for this node. */
export const INTERNAL_NODE_ID = "internal";

/** Product identity/path resolution stays server-side. No server DB handle reaches node code. `sourceId`
 * binds the session to another source of its project (the target of a hydrate) instead of its current one. */
export function provisionForSession(sessionId: string, sourceId?: number): { binding: NodeSessionBinding } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(sourceId ?? row.source_id);
  if (!source || source.project_id !== row.project_id || source.node_id !== "internal") {
    throw new Error(`Execution source unavailable for session ${sessionId}`);
  }
  return {
    binding: { sourceId: source.id, cwd: source.path, createdAt: row.created_at, parentSessionId: row.parent_session_id },
  };
}

export type NodeSessionReports = Pick<ServerHandlers, "event" | "started" | "settled">;
export type NodeToolCalls = Pick<ServerHandlers, "scriptExecute" | "scriptSearch" | "createTask">;
/** Server-side product services the composition root injects (`installRuntimeHooks`), so this adapter
 * imports no session runtime modules. */
export type NodeServerServices = NodeSessionReports & NodeToolCalls;
const services = new WeakMap<ServerState, NodeServerServices>();
/** Without installed services, live events are dropped, durable lifecycle reports are rejected (the
 * node keeps them pending) and tool calls are rejected. */
export function subscribeInternalNodeServices(state: ServerState, sink: NodeServerServices): () => void {
  services.set(state, sink);
  return () => { if (services.get(state) === sink) services.delete(state); };
}
const installed = (state: ServerState) => {
  const sink = services.get(state);
  if (!sink) throw new Error("Node server services unavailable");
  return sink;
};
/** Fencing: reports, uploads and tool calls are accepted only for sessions placed on this node, so a node
 * the session was moved away from (or one still hydrating it) cannot write to it. The
 * rejection is definite (`not_owner` as the error data): the node drops what it cannot deliver. */
const owned = (sessionId: string) => {
  if (!getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  if (!nodeOwnsSession(sessionId, INTERNAL_NODE_ID)) {
    const message = `Node session unavailable: ${sessionId}`;
    throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "not_owner", message, retryable: false } satisfies NodeError);
  }
};
/** Reads are also open while the session is at rest on the server or moving and this node is its destination. */
const readable = (sessionId: string) => {
  if (!getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  if (!nodeMayReadSession(sessionId, INTERNAL_NODE_ID)) throw new Error(`Node session unavailable: ${sessionId}`);
};

/** Node→server calls run only here, as protocol handlers; the ownership check authorizes the session
 * (unknown sessions, sessions another node owns, and sessions at rest on the server for writes are
 * rejected) before any product service runs. Credentials are not per session: the transport serves them
 * to any negotiated connection. */
export const internalNodeServer = (state: ServerState): ServerHandlers => ({
  ...createNodeCredentialService(),
  committed: ({ sessionId, startSeq, writesJson }) => {
    owned(sessionId);
    applyNodeReplica(getDb(), sessionId, startSeq, writesJson);
  },
  started: input => { owned(input.sessionId); return installed(state).started(input); },
  settled: input => { owned(input.sessionId); return installed(state).settled(input); },
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
  event: input => {
    owned(input.sessionId);
    return services.get(state)?.event(input);
  },
  // Tool calls carry only the session ID; the services derive project/task scope from the server's row.
  scriptExecute: async (input, signal) => { owned(input.sessionId); return installed(state).scriptExecute(input, signal); },
  scriptSearch: input => { owned(input.sessionId); return installed(state).scriptSearch(input); },
  createTask: async input => { owned(input.sessionId); return installed(state).createTask(input); },
});

/** The server end of the internal node's link. */
export interface InternalLink { closed(): boolean; close(): void; client(): Promise<NodeCommandClient> }
/** What `acceptInternalNodeConnection` needs from a connection: an accepted NDJSON Unix socket in
 * production, an in-memory socket in tests. */
export type InternalNodeSocket = WireSocket & { onmessage?: (data: string) => void; onclose?: () => void; readonly closed: boolean };

const links = new WeakMap<ServerState, InternalLink>();
const DISCONNECTED: InternalLink = {
  closed: () => true, close() {},
  async client() { throw new RpcFailure("unavailable", "Internal node not connected"); },
};

/**
 * Serves one local node connection (accepted by the process owner's listener). The server never starts
 * a node: the node runs in its own process and dials in. Once a connection negotiates `node.hello` it
 * becomes the internal node's only link: the previous link is closed, so its in-flight calls fail with
 * outcome unknown (submitted work requeues) and anything the old connection still sends carries an epoch
 * the new connection never issued (`-32003`). Queued work is woken. A connection that never negotiates
 * is closed by the hello timeout and never replaces a link.
 */
export function acceptInternalNodeConnection(state: ServerState, socket: InternalNodeSocket, options: LinkOptions = LOCAL_LINK): void {
  const server = createServerTransport(socket, internalNodeServer(state), options);
  socket.onmessage = server.receive;
  socket.onclose = () => {
    server.close();
    if (links.get(state) === link) logger.info("Internal node disconnected");
  };
  const link: InternalLink = { closed: () => socket.closed, close: () => socket.close(), client: async () => server };
  server.negotiated.then(() => {
    if (socket.closed) return;
    const previous = links.get(state);
    links.set(state, link);
    if (previous && previous !== link) previous.close();
    logger.info("Internal node connected");
    wakeScheduledCommands(state);
  }, () => undefined);
}

/** Delivers one command over the internal node's current link. Submitted work throws DeliveryDeferred
 * when the node did not receive, or may have admitted, it (including when no node is connected);
 * immediate controls return `unavailable` instead. */
export function sendInternal(state: ServerState, command: NodeCommand, binding: NodeSessionBinding, commandId?: string, timeouts: NodeCommandTimeouts = NODE_COMMAND_TIMEOUTS): Promise<NodeResult> {
  return sendNodeCommand(() => currentLink(state).client(), command, binding, commandId, timeouts);
}
/** Delivers `session.hydrate` over the internal node's current link (see `sendRelocationCommand`). */
export function sendInternalRelocation(state: ServerState, command: Extract<NodeCommand, { op: "session.hydrate" }>, binding: NodeSessionBinding, commandId: string, hydration: HydrationPayload, timeouts: NodeCommandTimeouts = NODE_COMMAND_TIMEOUTS): Promise<NodeResult> {
  return sendRelocationCommand(() => currentLink(state).client(), command, binding, commandId, hydration, timeouts);
}
function openLink(state: ServerState): InternalLink | undefined {
  const link = links.get(state);
  return link && !link.closed() ? link : undefined;
}
function currentLink(state: ServerState): InternalLink {
  const link = openLink(state);
  if (link) return link;
  const connect = connectorsForTesting.get(state);
  if (!connect) return DISCONNECTED;
  const connected = connect();
  links.set(state, connected);
  return connected;
}

const connectorsForTesting = new WeakMap<ServerState, () => InternalLink>();
/**
 * TEST SEAM ONLY: backend tests that run a node in the same process (the in-memory loopback in
 * `__tests__/helpers/loopback-node.ts`) register a connector that links it on first use and again after
 * the link closes (`linkNow` links immediately). Production never registers one: the server never starts
 * a node; the node process dials the process owner's listener (`acceptInternalNodeConnection`).
 */
export function setInternalNodeConnectorForTesting(state: ServerState, connect: () => InternalLink, { linkNow = false } = {}): void {
  connectorsForTesting.set(state, connect);
  if (linkNow) currentLink(state);
}
/** Whether a negotiated internal node connection is open. */
export function internalNodeConnected(state: ServerState): boolean { return openLink(state) !== undefined; }
/** Closes the current connection (handler uninstall, including hot reload). The node process keeps
 * running (its runs are untouched) and redials, reaching whichever handler is installed then. */
export function closeInternalNodeLink(state: ServerState): void {
  links.get(state)?.close();
  links.delete(state);
}
