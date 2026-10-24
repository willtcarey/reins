/**
 * The process and the app (ADR-029, docs/dev/hot-reload.md *Ownership*)
 *
 * What the process owns (`ServerProcess`, created by `server-process.ts`): the database, the browser
 * connections, the open sessions, the credential store's locks and the current app. What one app builds
 * (`AppState`, `createAppState`, called by `start` in `server.ts`): its node hub, `/nodes/link` endpoint and
 * node bundle, around the process. Routes, ws handlers and models receive the `AppState` as a parameter.
 *
 * Also the surfaces between a session runtime and an app: what an app calls on a runtime (`SessionRuntime`)
 * and what a runtime calls on the current app (`App`). A runtime keeps the code it was built with, so these
 * cross between code of different apps: a change to them needs a restart.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { LinkOptions, MethodCallOptions, MethodInput, MethodResult, NodeDocs, RequestMethod, WireSocket, nodeMethods } from "@reins/node-protocol";
import type { PromptBlock } from "./session-runtime/events.js";
import type { ScriptExecuteResult } from "./tools/execute.js";
import type { ScriptSearchResult } from "./tools/search.js";
import type { CreateTaskInput, CreateTaskResult } from "./tools/create-task.js";
import type { NodeStream } from "./nodes/node-streams.js";
import { createNodeHub, type NodeHubOptions } from "./nodes/node-hub.js";
import { createNodeLinks, type NodeLinks } from "./nodes/node-link.js";
import type { NodeBundleDelivery } from "./node-bundle/delivery.js";

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

/** The handlers that drive a socket an app upgraded (`/nodes/link`), for the life of that socket. */
export interface SocketHandlers {
  open(ws: UpgradedSocket): void;
  message(ws: UpgradedSocket, message: string | Buffer): void;
  /** Bun's backpressure drain: the socket may have written out what it held. */
  drain(ws: UpgradedSocket): void;
  close(ws: UpgradedSocket, code: number, reason: string): void;
}
/** What the process's HTTP server keeps on a WebSocket it upgraded (`server.upgrade(req, {data})`). A
 * socket with `handlers` is driven by them, so it belongs to the app that upgraded it (a reload
 * closes it); one without is a browser socket (`/ws`), which the process registers as a browser connection (`ServerProcess.broadcast`)
 * and which outlives reloads. */
export interface UpgradeData { handlers?: SocketHandlers }
export type UpgradedSocket = ServerWebSocket<UpgradeData>;
/** The part of Bun's server an upgrade needs (`RouteContext.server`). */
export interface UpgradeServer {
  upgrade(request: Request, options: { data: UpgradeData }): boolean;
}

/** A browser connection as the process registers it (`server-process.ts`). */
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
 * The node bundle a node runs, as its hello announced it to this app (ADR-025): `current`, this app's
 * build; `outdated`, another build, served because this app has none to offer (its build failed);
 * `updating`, another build, which it was told to replace (it was not served, and has not said hello since).
 */
export interface NodeBuild { id: string; status: "current" | "outdated" | "updating" }

/** Why a node's latest hello to this app did not negotiate; `at` is ISO 8601. */
export interface NodeFailure { message: string; at: string }

/**
 * A node as product code calls it, addressed by its ID rather than by a connection: every call goes
 * over the node's link at the time of the call, so holding one across reconnects is safe. Calls are
 * request-now, never queued: one rejects (an `RpcFailure`) when the node is not connected, does not
 * answer in time or refuses.
 */
export interface NodeClient {
  readonly id: string;
  /** Whether a negotiated connection of the node is open now. */
  readonly connected: boolean;
  /** The build it runs while connected, or was told to replace; null from source (no build announced), or
   * when it has not said hello to this app since it last disconnected. */
  readonly build: NodeBuild | null;
  /** Cleared when it next connects to this app. */
  readonly failure: NodeFailure | null;
  /** Where its REINS docs are, as its hello said, while it is connected (the model reads them with `read`,
   * on the node); null while it is not connected. */
  readonly docs: NodeDocs | null;
  /** Calls a node method, e.g. `fs.list`. */
  request<M extends RequestMethod<NodeMethods>>(method: M, input: MethodInput<NodeMethods[M]>, options?: MethodCallOptions): Promise<MethodResult<NodeMethods[M]>>;
  /** Calls a stream-opening node method, e.g. `process.run`, with the `streamId` the server allocates,
   * and returns its stream (node-transport.md *Streams*). Also rejects with the method's refusal. */
  openStream<M extends StreamMethod>(method: M, input: Omit<MethodInput<NodeMethods[M]>, "streamId">, options?: MethodCallOptions): Promise<NodeStream<MethodResult<NodeMethods[M]>>>;
}

/** How a transport has the hub serve one connection: its link options, and `authenticate` when the
 * connection must prove which paired node it is (`node.authenticate`, signed for `origin`, the server
 * origin the transport serves) before its hello is answered. The local socket passes none: its file permissions are
 * its authentication. */
export interface AcceptOptions extends LinkOptions {
  authenticate?: { origin: string };
}

/**
 * The node hub of one app (`nodes/node-hub.ts`): the negotiated connection of every
 * connected node (by the node ID it announced). No node is special. Product code calls a node directly
 * through `get`.
 */
export interface NodeHub {
  /** Serves one node connection (`LOCAL_LINK` options by default); once it negotiates `node.hello` for a
   * known node ID, after authenticating as that node if `options.authenticate`, it is that node's link. */
  accept(socket: NodeSocket, options?: AcceptOptions): void;
  /** The node `nodeId` (whether or not it is connected). */
  get(nodeId: string): NodeClient;
  /** Closes node `nodeId`'s link, if it has one (its calls in flight fail with outcome unknown). */
  disconnect(nodeId: string): void;
  /** Process shutdown or a reload: closes every node connection (its calls in flight fail with
   * outcome unknown). */
  close(): Promise<void>;
}

/** One app's state (ADR-029): the process it runs in (`process`: the database, browser connections, open
 * sessions, credential locks and frontend directory) and what the app builds for itself, replaced on every reload:
 * its node hub, `/nodes/link` endpoint and node bundle. Routes, ws handlers and models are served with it. */
export interface AppState {
  readonly process: ServerProcess;
  nodes: NodeHub;
  /** `/nodes/link`: the WebSocket connections of remote nodes, which this app's hub serves. */
  nodeLinks: NodeLinks;
  /** `/nodes/*`: the install script, manifest and bundle this app built (node-bundle/delivery.ts). */
  nodeBundle: NodeBundleDelivery;
}

/**
 * What the current app offers the session runtimes the process keeps (ADR-029): reaching a node and the
 * Reins tools, product code that hot reloads. The app registers it with the process when it starts
 * (`ServerProcess.registerApp`) and unregisters it when it stops. A runtime reaches it per call,
 * `process.app?.…`, and never keeps one: a runtime built by an older app calls a newer one through this, so
 * keep it small; a change that breaks it needs a restart. A runtime applies its run lifecycle itself, with
 * no app (docs/dev/session-runtime.md *Lifecycle and child reports*).
 */
export interface App {
  /** The identity of the code this app runs (`APP_CODE`, `session-runtime/live.ts`: one per app bundle): a
   * runtime opened by other code while this app is current is retired at once. */
  readonly code: symbol;
  /** Node `nodeId`, through this app's hub. Throws when the node was removed (its sessions take no work). */
  node(nodeId: string): NodeClient;
  /** The Reins tools' server operations for `sessionId`, scoped by its row. A failure whose `outcome` is
   * `"unknown"` may have run (the app stopped under it); `"not_run"` did not run. */
  executeScript(sessionId: string, code: string, signal?: AbortSignal): Promise<ScriptExecuteResult>;
  searchScript(sessionId: string, query: string, signal?: AbortSignal): Promise<ScriptSearchResult>;
  createTask(sessionId: string, input: CreateTaskInput, signal?: AbortSignal): Promise<CreateTaskResult>;
}

/** What an app calls on a live session runtime, whichever app built it. */
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
  /** Starts compacting the context, resolving once Pi accepted it; refused (`CompactionRefusedError`)
   * while busy or with nothing to compact. */
  compact(options?: { instructions?: string }): Promise<void>;
  /** An admission or run is in flight. */
  isStreaming(): boolean;
  /** Streaming, or a run's end still being applied (its record, a child's report): the session is
   * running. */
  isBusy(): boolean;
  /** Resolves once it is not busy (at once when it is not). */
  whenIdle(): Promise<void>;
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
  /** Built by an app that is no longer current: closed once idle, and reopened on the new code meanwhile. */
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
 * The sessions the process keeps running across apps (ADR-029): live runtimes, which an app fills and the
 * process's idle sweep empties; the openings in progress; live event seqs; submission chains; the pause gate.
 */
export interface OpenSessions {
  /** Live runtimes by session ID. */
  readonly live: Map<string, OpenSession>;
  /** Openings in progress by session ID, so concurrent opens of one session share one. */
  readonly opening: Map<string, Promise<SessionRuntime>>;
  /** The last live event seq of each session, for the life of the process. */
  readonly eventSeqs: Map<string, number>;
  /** The tail of each session's submission chain while it has submissions in progress: a session's
   * submissions (prompt, steer, model changes) apply one at a time, in arrival order, across apps. */
  readonly submissions: Map<string, Promise<void>>;
  readonly pauseGate: PauseGate;
  /** Closes the runtimes idle `RUNTIME_IDLE_MS` and the retired ones now idle (every `IDLE_SWEEP_INTERVAL_MS`). */
  sweep(): void;
}

/** The per-provider lock of the server's credential store, which serializes a provider's reads-and-writes
 * (an OAuth refresh rotates its refresh token). The process owns it so that every user of the store (an
 * app's routes and model catalog, every session's runtime, whichever app built it) takes the same lock;
 * the store itself is app code (`DbCredentialStore` in `pi/credential-store.ts`, over this). */
export interface CredentialLocks {
  /** Runs `work` once the provider's earlier work is done. */
  run<T>(providerId: string, work: () => Promise<T>): Promise<T>;
}

/**
 * What the process owns (ADR-029), created once by `server-process.ts` and passed whole to each app
 * (`start` in `server.ts`, `AppState.process`) and kept by session runtimes. Only it outlives an app: a
 * session runtime may keep it, never an `AppState` or an `App`, and reads the app from `app` at each call
 * (none during a reload's gap). A change to it needs a restart.
 */
export interface ServerProcess {
  /** The database connection: opened once (with its pragmas); each app migrates it, none closes it. */
  readonly db: Database;
  /** Sends a serialized frame to every browser connection (the process registers them: they outlive
   * apps). Typed messages: `createBroadcast` (`models/broadcast.ts`). */
  broadcast(frame: string): void;
  readonly sessions: OpenSessions;
  /** The credential store's per-provider locks. */
  readonly credentialLocks: CredentialLocks;
  /** The current app: undefined during a reload's gap (from one app's `stop` to the next one's start) and
   * before the first app. Nothing waits for it: each caller handles the gap (docs/dev/session-runtime.md
   * *Reaching the current app*). */
  readonly app: App | undefined;
  /** An app starts: runtimes earlier apps built are closed at once when idle and retired otherwise.
   * Returns its unregistration (its `stop`), after which `app` is undefined until the next one. */
  registerApp(app: App): () => void;
  readonly frontendDir: string;
  /** The local node socket path each app listens on. */
  readonly nodeSocket: string;
}

/** One app's state: the process's, a new node hub, the `/nodes/link` endpoint handing its connections to
 * that hub, and the node bundle the app serves. */
export function createAppState(serverProcess: ServerProcess, nodeBundle: NodeBundleDelivery, { hub }: { hub?: NodeHubOptions } = {}): AppState {
  const state: AppState = {
    process: serverProcess,
    nodes: createNodeHub(() => state, hub),
    nodeLinks: createNodeLinks((socket, options) => state.nodes.accept(socket, options)),
    nodeBundle,
  };
  return state;
}
