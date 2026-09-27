import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair, RpcFailure } from "@reins/node/protocol";
import { createServerTransport, type ServerHandlers } from "../node-transport/server-peer.js";
import { NODE_COMMAND_TIMEOUTS, sendNodeCommand, type NodeCommandClient, type NodeCommandTimeouts } from "../node-transport/commands.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import type { NodeSessionBinding } from "@reins/node/storage";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import type { ServerState } from "../state.js";
import { applyNodeReplica } from "../node-replica.js";
import { createNodeCredentialService } from "./node-credentials.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import type { StoredAttachment } from "@reins/node/protocol";

/** Product identity/path resolution stays server-side. No server DB handle reaches node code. */
export function provisionForSession(sessionId: string): { binding: NodeSessionBinding; storageOwner: string } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id || source.node_id !== "internal") {
    throw new Error(`Execution source unavailable for session ${sessionId}`);
  }
  return {
    storageOwner: row.storage_owner,
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
const owned = (sessionId: string) => {
  if (provisionForSession(sessionId).storageOwner !== "internal-node") throw new Error(`Node session unavailable: ${sessionId}`);
};

/** Node→server calls run only here, as protocol handlers; the storage owner check authorizes the session
 * (unknown or server-owned sessions are rejected) before any product service runs. Credentials are not
 * per session: the transport serves them to any negotiated connection. */
export const internalNodeServer = (state: ServerState): ServerHandlers => ({
  ...createNodeCredentialService(),
  committed: ({ sessionId, startSeq, writesJson }) => {
    owned(sessionId);
    applyNodeReplica(getDb(), sessionId, startSeq, writesJson);
  },
  started: input => { owned(input.sessionId); return installed(state).started(input); },
  settled: input => { owned(input.sessionId); return installed(state).settled(input); },
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
  event: input => {
    owned(input.sessionId);
    return services.get(state)?.event(input);
  },
  // Tool calls carry only the session ID; the services derive project/task scope from the server's row.
  scriptExecute: async (input, signal) => { owned(input.sessionId); return installed(state).scriptExecute(input, signal); },
  scriptSearch: input => { owned(input.sessionId); return installed(state).scriptSearch(input); },
  createTask: async input => { owned(input.sessionId); return installed(state).createTask(input); },
});

/** Every server→node session command crosses the same JSON-RPC schemas and handlers a remote node
 * uses, over an in-memory socket; the server never calls `Node.send` directly. */
function connectInternal(state: ServerState, node: Node) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  // In-process frames are uncapped: committed batches are never split.
  const uncapped = { maxFrameBytes: Infinity };
  const server = createServerTransport(serverEnd, internalNodeServer(state), uncapped);
  const connection = connectNode(node, nodeEnd, "internal", uncapped);
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  const ready = connection.ready.catch((error: unknown) => {
    throw new RpcFailure("unavailable", `Internal node negotiation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  ready.catch(() => undefined);
  return {
    closed: () => serverEnd.closed,
    close: () => serverEnd.close(),
    async client(): Promise<NodeCommandClient> { await ready; return server; },
  };
}

const nodes = new WeakMap<ServerState, Node>();
const links = new WeakMap<ServerState, ReturnType<typeof connectInternal>>();
/** Delivers one command over the internal link (recreated when closed). Submitted work throws
 * DeliveryDeferred when the node did not receive, or may have admitted, it; immediate controls return
 * `unavailable` instead. */
export function sendInternal(state: ServerState, command: NodeCommand, binding: NodeSessionBinding, commandId?: string, timeouts: NodeCommandTimeouts = NODE_COMMAND_TIMEOUTS): Promise<NodeResult> {
  const { link } = started(state);
  return sendNodeCommand(() => link.client(), command, binding, commandId, timeouts);
}
/** Starts the node on first use and keeps a live link: replica delivery, attachment fetch and lifecycle
 * reports need one even when no command has recreated it. */
function started(state: ServerState) {
  let node = nodes.get(state);
  if (!node) {
    // No in-process dependency: configuration travels with `session.provision` and credentials are
    // served over the link (`credentials.*`).
    node = startNode();
    nodes.set(state, node);
  }
  let link = links.get(state);
  if (!link || link.closed()) { link = connectInternal(state, node); links.set(state, link); }
  return { node, link };
}
export function internalNodeFor(state: ServerState): Node { return started(state).node; }
export function stopInternalNode(state: ServerState): void {
  links.get(state)?.close();
  links.delete(state);
  nodes.get(state)?.stop();
  nodes.delete(state);
}
