import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair, RpcFailure, type Provision, type SessionConfiguration, type SessionConfigurationRequest } from "@reins/node/protocol";
import { createServerTransport, type ServerHandlers } from "../node-transport/server-peer.js";
import { provisionOutcome } from "../node-transport/provision.js";
import type { NodeResult } from "@reins/node/contract";
import type { NodeSessionBinding } from "@reins/node/storage";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import type { ServerState } from "../state.js";
import { applyNodeReplica } from "../node-replica.js";
import { createDbCredentialStore } from "./pi/credential-store.js";
import { getSessionAttachment } from "../session-attachments-store.js";
import { getSetting } from "../settings-store.js";
import { parseThinkingLevel } from "../models/model-settings.js";
import { getTask } from "../task-store.js";

/** Product identity/path/config resolution stays server-side. No server DB handle reaches node code. */
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

/** `session.configuration`: the node opening a runtime asks for its session's model selection and task.
 * The node's binding must match the server's current product row for an internal-node-owned session. */
function sessionConfiguration({ sessionId, binding }: SessionConfigurationRequest): SessionConfiguration {
  const current = provisionForSession(sessionId);
  if (current.storageOwner !== "internal-node" || JSON.stringify(current.binding) !== JSON.stringify(binding)) {
    throw new Error(`Node session binding mismatch: ${sessionId}`);
  }
  const row = getSession(sessionId)!;
  const defaultModel = getSetting("default_model");
  const model = row.model_provider && row.model_id
    ? { provider: row.model_provider, modelId: row.model_id }
    : defaultModel?.runtimeType === row.agent_runtime_type
      ? { provider: defaultModel.provider, modelId: defaultModel.modelId }
      : null;
  const thinkingLevel = row.thinking_level === "off" ? null : row.thinking_level
    ? parseThinkingLevel(row.thinking_level)
    : defaultModel?.runtimeType === row.agent_runtime_type ? defaultModel.thinkingLevel : null;
  const task = row.task_id ? getTask(row.task_id) : null;
  if (row.task_id && !task) throw new Error(`Task not found: ${row.task_id}`);
  return {
    model, thinkingLevel: thinkingLevel ?? null,
    task: task ? { title: task.title, description: task.description, branchName: task.branch_name } : null,
  };
}

/** Node→server calls run only here, as protocol handlers; the storage owner check authorizes the session
 * (unknown or server-owned sessions are rejected) before any product service runs. */
export const internalNodeServer = (state: ServerState): ServerHandlers => ({
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
  configuration: sessionConfiguration,
  event: input => {
    owned(input.sessionId);
    return services.get(state)?.event(input);
  },
  // Tool calls carry only the session ID; the services derive project/task scope from the server's row.
  scriptExecute: async (input, signal) => { owned(input.sessionId); return installed(state).scriptExecute(input, signal); },
  scriptSearch: input => { owned(input.sessionId); return installed(state).scriptSearch(input); },
  createTask: async input => { owned(input.sessionId); return installed(state).createTask(input); },
});

/** Internal provision crosses the same JSON-RPC schemas and handlers a remote node uses, over an
 * in-memory socket; prompt/steer/abort/resume and open() still call `Node` directly. */
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
    async provision(input: Provision, timeoutMs: number) { await ready; return server.provision(input, timeoutMs); },
  };
}

const nodes = new WeakMap<ServerState, Node>();
const links = new WeakMap<ServerState, ReturnType<typeof connectInternal>>();
const PROVISION_TIMEOUT_MS = 30_000;
/** Throws DeliveryDeferred when the node did not receive, or may have admitted, the command. */
export function provisionInternal(state: ServerState, input: Provision, timeoutMs = PROVISION_TIMEOUT_MS): Promise<NodeResult> {
  const node = internalNodeFor(state);
  let link = links.get(state);
  if (!link || link.closed()) { link = connectInternal(state, node); links.set(state, link); }
  const current = link;
  return provisionOutcome(() => current.provision(input, timeoutMs));
}
export function installedInternalNode(state: ServerState): Node | undefined { return nodes.get(state); }
export function internalNodeFor(state: ServerState): Node {
  let node = nodes.get(state);
  if (!node) {
    // Session configuration crosses the link (`session.configuration`); only the credential store
    // is still an in-process dependency, pending a credentials RPC.
    node = startNode({ credentials: createDbCredentialStore() });
    nodes.set(state, node);
  }
  // Replica delivery and attachment fetch need a live link even when no provision has recreated it.
  const link = links.get(state);
  if (!link || link.closed()) links.set(state, connectInternal(state, node));
  return node;
}
export function stopInternalNode(state: ServerState): void {
  links.get(state)?.close();
  links.delete(state);
  nodes.get(state)?.stop();
  nodes.delete(state);
}
