/**
 * Server State
 *
 * The state handlers are served with, and how a handler load builds it (`createServerState`, called by
 * `start` in `server.ts`): browser clients outlive a reload, the node hub is the load's own.
 * handler.ts and ws.ts receive it as a parameter.
 *
 * Also the types of what the process owns across loads for sessions (ADR-029): the live runtimes, the
 * pause gate and the load serving now (`ProcessSessions`, created in `process-state.ts`), and the two
 * surfaces between a runtime and a load: what a load calls on a runtime (`SessionRuntime`) and what a runtime
 * calls on the load serving now (`Server`). A runtime keeps the code it was built with, so these
 * cross between code of different loads: a change to them needs a restart.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { LinkOptions, MethodCallOptions, MethodInput, MethodResult, RequestMethod, WireSocket, nodeMethods } from "@reins/node-protocol";
import type { PromptBlock } from "./session-runtime/events.js";
import type { ReinsToolCalls } from "./tools/index.js";
import type { SessionSettled } from "./sessions/session-runs.js";
import type { NodeStream } from "./nodes/node-streams.js";
import { createNodeHub, type NodeHubOptions } from "./nodes/node-hub.js";
import { createNodeLinks, type NodeLinks } from "./nodes/node-link.js";
import type { NodeBundleDelivery } from "./node-bundle/delivery.js";
import type { SpawnedProcess, SpawnOptions } from "./spawn.js";

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

/** The handlers that drive a socket a handler load upgraded (`/nodes/link`), for the life of that socket. */
export interface SocketHandlers {
  open(ws: UpgradedSocket): void;
  message(ws: UpgradedSocket, message: string | Buffer): void;
  /** Bun's backpressure drain: the socket may have written out what it held. */
  drain(ws: UpgradedSocket): void;
  close(ws: UpgradedSocket, code: number, reason: string): void;
}
/** What the process's HTTP server keeps on a WebSocket it upgraded (`server.upgrade(req, {data})`). A
 * socket with `handlers` is driven by them, so it belongs to the handler load that upgraded it (a reload
 * closes it); one without is a browser socket (`/ws`), which the process registers in `clients` and which
 * outlives reloads. */
export interface UpgradeData { handlers?: SocketHandlers }
export type UpgradedSocket = ServerWebSocket<UpgradeData>;
/** The part of Bun's server an upgrade needs (`RouteContext.server`). */
export interface UpgradeServer {
  upgrade(request: Request, options: { data: UpgradeData }): boolean;
}

export interface WsClient {
  ws: WebSocketLike;
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
/**
 * The node bundle a node runs, as its hello announced it to this load (ADR-025): `current`, this load's
 * build; `outdated`, another build, served because this load has none to offer (its build failed);
 * `updating`, another build, which it was told to replace (it was not served, and has not said hello since).
 */
export interface NodeBuild { id: string; status: "current" | "outdated" | "updating" }

export interface RemoteNode {
  readonly id: string;
  /** Whether a negotiated connection of the node is open now. */
  readonly connected: boolean;
  /** The build it runs while connected, or was told to replace; null from source (no build announced), or
   * when it has not said hello to this load since it last disconnected. */
  readonly build: NodeBuild | null;
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

/** How a transport has the hub serve one connection: its link options, and `authenticate` when the
 * connection must prove which paired node it is (`node.authenticate`, signed for `origin`, the server
 * origin the transport serves) before its hello is answered. The local socket passes none: its file permissions are
 * its authentication. */
export interface AcceptOptions extends LinkOptions {
  authenticate?: { origin: string };
}

/**
 * The node hub of one handler load (`nodes/node-hub.ts`): the negotiated connection of every
 * connected node (by the node ID it announced). No node is special. Product code calls a node directly
 * through `get`.
 */
export interface NodeHub {
  /** Serves one node connection (`LOCAL_LINK` options by default); once it negotiates `node.hello` for a
   * known node ID, after authenticating as that node if `options.authenticate`, it is that node's link. */
  accept(socket: NodeSocket, options?: AcceptOptions): void;
  /** The node `nodeId` (whether or not it is connected). */
  get(nodeId: string): RemoteNode;
  /** Closes node `nodeId`'s link, if it has one (its calls in flight fail with outcome unknown). */
  disconnect(nodeId: string): void;
  /** Process shutdown or a handler reload: closes every node connection (its calls in flight fail with
   * outcome unknown). */
  close(): Promise<void>;
}

/** What handlers are served with: the process's browser clients and frontend directory, and this
 * handler load's node hub, remote node link endpoint and node bundle. */
export interface ServerState {
  clients: Set<WsClient>;
  frontendDir: string;
  nodes: NodeHub;
  /** The sessions the process runs. */
  sessions: ProcessSessions;
  /** `/nodes/link`: the WebSocket connections of remote nodes, which this load's hub serves. */
  nodeLinks: NodeLinks;
  /** `/nodes/*`: the install script, manifest and bundle this load built (node-bundle/delivery.ts). */
  nodeBundle: NodeBundleDelivery;
}

/** Bytes of a session attachment with their metadata. */
export interface AttachmentBytes {
  data: Uint8Array;
  mimeType: string;
  byteSize: number;
  sha256: string;
  filename?: string;
  width?: number;
  height?: number;
}

/**
 * What a session runtime reaches of the handler load serving now (ADR-029), resolved at each call through
 * `ProcessSessions.server`, never captured from the load that built the runtime. A runtime built by an older
 * load calls a newer load through this, so keep it small: a change that breaks it needs a restart.
 */
export interface Server {
  /** Node `nodeId`, through this load's hub. Throws when the node was removed (its sessions take no work). */
  node(nodeId: string): RemoteNode;
  /** The server's credentials, under this load's per-provider refresh lock. */
  readonly credentials: CredentialStore;
  /** Run lifecycle (`sessions/session-runs.ts`). */
  runStarted(sessionId: string, runId: string): void;
  /** Resolves once applied (a child's report steered to its parent first). */
  runSettled(report: SessionSettled): Promise<void>;
  /** The Reins tools' server operations for `sessionId`, scoped by its row. A failure whose `outcome` is
   * `"unknown"` may have run (the load stopped under it); `"not_run"` did not run. */
  toolCalls(sessionId: string): ReinsToolCalls;
  /** The session's attachment, or null when it has none by that ID (or its bytes were pruned). */
  attachment(sessionId: string, attachmentId: string): AttachmentBytes | null;
  /** Stores an attachment under the runtime's ID (the same ID and content again is a no-op). */
  storeAttachment(sessionId: string, attachmentId: string, attachment: AttachmentBytes): void;
}

/** What a load calls on a live session runtime, whichever load built it. */
export interface SessionRuntime {
  /** Durably admits a prompt under `reinsId` (a repeat converges on the admitted input) and drives its run
   * in the background; resolves once Pi committed it. */
  prompt(content: PromptBlock[], options: { reinsId: string; metadata?: Record<string, unknown> }): Promise<{ messageId: string }>;
  /** Queues steering input under `reinsId` (a repeat does nothing). */
  steer(content: PromptBlock[], options: { reinsId: string; metadata?: Record<string, unknown> }): Promise<void>;
  setModel(params: { provider: string; modelId: string; thinkingLevel?: string | null }): Promise<void>;
  /** Aborts the run in progress and waits for the lane to go idle. */
  abort(): Promise<void>;
  /** Drives a run an interruption left pending: true when one is being driven. */
  resumePendingOperation(): Promise<boolean>;
  /** An admission or run is in flight. */
  isStreaming(): boolean;
  /** Cutting it off now loses nothing: every run it drives is held at a pause point. */
  isPaused(): boolean;
  /** Aborts its run and closes it. */
  close(): Promise<void>;
  /** Closes it without aborting its run, which stays pending in storage. */
  suspend(): Promise<void>;
}

/** A live runtime as the process keeps it. */
export interface OpenSession {
  runtime: SessionRuntime;
  /** What it was opened for (the session's binding, as JSON): a session bound elsewhere is reopened. */
  binding: string;
  /** When it was last used or emitted an event (`Date.now()`). */
  lastActivity: number;
  /** Built by a load that no longer serves: closed once idle, and reopened on the new code meanwhile. */
  retired: boolean;
  /** A storage call failed under it (Pi faulted its harness): never reused, reopened whatever it does. */
  faulted: boolean;
}

/** Holds runs at their pause points while closed (ADR-021): one for the process. */
export interface PauseGate {
  readonly closed: boolean;
  close(): void;
  open(): void;
  /** Resolves once the gate is open or `signal` aborts. Never rejects. */
  pass(signal: AbortSignal | undefined): Promise<void>;
}

/**
 * The sessions the process keeps running across handler loads (ADR-029): live runtimes, which a load fills
 * and the process's idle sweep empties; the openings in progress; live event seqs; the pause gate; and the
 * load serving now, which a runtime reaches only through `server`.
 */
export interface ProcessSessions {
  /** Live runtimes by session ID. */
  readonly live: Map<string, OpenSession>;
  /** Openings in progress by session ID, so concurrent opens of one session share one. */
  readonly opening: Map<string, Promise<SessionRuntime>>;
  /** The last live event seq of each session, for the life of the process. */
  readonly eventSeqs: Map<string, number>;
  /** The tail of each session's submission chain while it has submissions in progress: a session's
   * submissions (prompt, steer, model changes) apply one at a time, in arrival order, across loads. */
  readonly submissions: Map<string, Promise<void>>;
  readonly pauseGate: PauseGate;
  /** The load serving now. During a reload it waits for the next one, until `signal` aborts (rejecting
   * with its reason) or a bound (`SERVER_WAIT_MS`) passes (rejecting with an error named `NoServer`). */
  server(signal?: AbortSignal): Promise<Server>;
  /** A load starts serving: runtimes built by earlier loads are closed at once when idle and retired
   * otherwise. Returns its release (its `stop`), after which calls wait for the next load. */
  serve(server: Server): () => void;
}

/** What the process owns for sessions and hands every load: its database connection (opened once, with
 * its pragmas; each load migrates it and none closes it), its browser clients and its live sessions. */
export interface SessionProcess {
  db: Database;
  clients: Set<WsClient>;
  sessions: ProcessSessions;
}

/** One handler load's server state: the process's browser clients, frontend directory and sessions, a new
 * node hub, the `/nodes/link` endpoint handing its connections to that hub, and the node bundle the load
 * serves. */
export function createServerState(clients: Set<WsClient>, frontendDir: string, nodeBundle: NodeBundleDelivery, sessions: ProcessSessions, { hub }: { hub?: NodeHubOptions } = {}): ServerState {
  const state: ServerState = {
    clients, frontendDir, sessions,
    nodes: createNodeHub(() => state, hub),
    nodeLinks: createNodeLinks((socket, options) => state.nodes.accept(socket, options)),
    nodeBundle,
  };
  return state;
}
