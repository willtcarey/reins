/**
 * Server State
 *
 * The state handlers are served with, and how a handler load builds it (`createServerState`, called by
 * `start` in `server.ts`): browser clients outlive a reload, the node hub is the load's own.
 * handler.ts and ws.ts receive it as a parameter. The server holds no session runtimes: sessions run on nodes.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

import type { LinkOptions, MethodCallOptions, MethodInput, MethodResult, RequestMethod, WireSocket, nodeMethods } from "@reins/node-protocol";
import type { NodeStream } from "./nodes/node-streams.js";
import { createNodeHub, type NodeHubOptions } from "./nodes/node-hub.js";
import type { SpawnedProcess, SpawnOptions } from "./spawn.js";

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

export interface WsClient {
  ws: WebSocketLike;
  /** The inputs this client submitted that have not settled, so a failure reaches its submitter
   * (`observeSubmission`). */
  submissions?: Set<string>;
}

/** A node connection as the process owner's listener accepts it: an NDJSON Unix socket in production,
 * an in-memory socket in tests. */
export type NodeSocket = WireSocket & { onmessage?: (data: string) => void; onclose?: () => void; readonly closed: boolean };

type NodeMethods = typeof nodeMethods;
/** The node methods that open a stream: their params carry the `streamId` the server allocates. */
export type StreamMethod = { [M in RequestMethod<NodeMethods>]: MethodInput<NodeMethods[M]> extends { streamId: string } ? M : never }[RequestMethod<NodeMethods>];

/**
 * A node as product code calls it, addressed by its ID rather than by a connection: every call goes
 * over the node's link at the time of the call, so holding one across reconnects is safe. Calls are
 * request-now, never queued: one rejects (an `RpcFailure`) when the node is not connected, does not
 * answer in time or refuses.
 */
export interface RemoteNode {
  readonly id: string;
  /** Whether a negotiated connection of the node is open now. */
  readonly connected: boolean;
  /** Calls a node method, e.g. `fs.list`. */
  request<M extends RequestMethod<NodeMethods>>(method: M, input: MethodInput<NodeMethods[M]>, options?: MethodCallOptions): Promise<MethodResult<NodeMethods[M]>>;
  /** Calls a stream-opening node method, e.g. `process.run`, with the `streamId` the server allocates,
   * and returns its stream (node-transport.md *Streams*). Also rejects when the node does not serve
   * streams, and with the method's refusal. */
  openStream<M extends StreamMethod>(method: M, input: Omit<MethodInput<NodeMethods[M]>, "streamId">, options?: MethodCallOptions): Promise<NodeStream<MethodResult<NodeMethods[M]>>>;
  /** Starts `argv` (no shell) in a source's checkout on the node (`process.run`). Rejects (an
   * `RpcFailure`) when the node does not accept it in time or refuses it (a missing checkout or
   * program); a link that drops later fails `stdout` and `exited` alike. */
  spawn(argv: string[], options: SpawnOptions & { sourceId: number; cwd: string }): Promise<SpawnedProcess>;
}

/**
 * The node hub of one handler load (`nodes/node-hub.ts`): the negotiated connection of every
 * connected node (by the node ID it announced) and the command dispatcher. No node is special: a
 * session's outbox commands go to the node of its source. Product code calls a node directly through
 * `get`.
 */
export interface NodeHub {
  /** Serves one node connection; once it negotiates `node.hello` for a known node ID it is that node's link. */
  accept(socket: NodeSocket, options?: LinkOptions): void;
  /** The node `nodeId` (whether or not it is connected). */
  get(nodeId: string): RemoteNode;
  /** A credential for `providerId` was set or deleted: tells every connected node (`credentials.changed`)
   * to drop what it cached. Best effort: a node that misses it re-reads credentials when it next attaches. */
  credentialsChanged(providerId: string): void;
  /** Scans the outbox now (a hint: the dispatcher reads SQLite). Callers need not await it: it resolves
   * (never rejects) once no delivery is in progress. */
  wake(): Promise<void>;
  /** Starts the periodic outbox scan. */
  start(): void;
  /** Process shutdown or a handler reload: stops delivery and closes every node connection. Resolves
   * once the deliveries in flight have settled (each requeued, admitted or failed). */
  close(): Promise<void>;
}

/** What handlers are served with: the process's browser clients and frontend directory, and this
 * handler load's node hub. */
export interface ServerState {
  clients: Set<WsClient>;
  frontendDir: string;
  nodes: NodeHub;
}

/** One handler load's server state: the process's browser clients and frontend directory, and a new node
 * hub. The hub is not started (`state.nodes.start()`). */
export function createServerState(clients: Set<WsClient>, frontendDir: string, hub?: NodeHubOptions): ServerState {
  const state: ServerState = { clients, frontendDir, nodes: createNodeHub(() => state, hub) };
  return state;
}
