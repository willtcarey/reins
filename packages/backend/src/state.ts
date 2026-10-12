/**
 * The process and the app (ADR-029, docs/dev/hot-reload.md *Ownership*)
 *
 * What the process owns (`ServerProcess`, created by `server-process.ts`): the database, the browser
 * connections, the node hub and its links, the open sessions, the credential store's locks and the current
 * app. What one app builds (`AppState`, `createAppState`, called by `start` in `server.ts`): its node bundle,
 * around the process. Routes, ws handlers and models receive the `AppState` as a parameter.
 *
 * Also the surfaces between process-owned code and an app: what an app calls on a runtime (`SessionRuntime`)
 * and what a runtime or the node hub calls on the current app (`App`). A runtime keeps the code it was built
 * with, and the hub is the process's, so these cross between code of different apps: a change to them needs
 * a restart.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { BuildUpdate, LinkOptions, MethodCallOptions, MethodInput, MethodResult, RequestMethod, WireSocket, nodeMethods } from "@reins/node-protocol";
import type { PromptBlock } from "./session-runtime/events.js";
import type { ScriptExecuteResult } from "./tools/execute.js";
import type { ScriptSearchResult } from "./tools/search.js";
import type { CreateTaskInput, CreateTaskResult } from "./tools/create-task.js";
import type { SessionSettled } from "./sessions/session-runs.js";
import type { NodeStream } from "./nodes/node-streams.js";
import type { NodeLinks } from "./nodes/node-link.js";
import type { NodeBundleDelivery } from "./node-bundle/delivery.js";
import type { SpawnedProcess, SpawnOptions } from "./spawn.js";

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

/** The handlers that drive a socket upgraded with its own (`/nodes/link`, the process's), for the life of that socket. */
export interface SocketHandlers {
  open(ws: UpgradedSocket): void;
  message(ws: UpgradedSocket, message: string | Buffer): void;
  /** Bun's backpressure drain: the socket may have written out what it held. */
  drain(ws: UpgradedSocket): void;
  close(ws: UpgradedSocket, code: number, reason: string): void;
}
/** What the process's HTTP server keeps on a WebSocket it upgraded (`server.upgrade(req, {data})`). A
 * socket with `handlers` is driven by them: a remote node's link, whose handlers are the process's
 * (`ServerProcess.nodeLinks`), so no app's stop closes it; one without is a browser socket (`/ws`), which
 * the process registers as a browser connection (`ServerProcess.broadcast`). Both outlive reloads. */
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

/** A node connection as the process's listener accepts it: an NDJSON Unix socket in production,
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
 * The node bundle a node runs, as its last hello announced it (ADR-025), judged against the build of the
 * app that answered that hello: `current`, that app's build; `outdated`, another build, served because that
 * app had none to offer (its build failed); `updating`, another build, which it was told to replace (it was
 * not served, and has not said hello since). A reload does not judge it again: the node is told to update
 * at its next hello.
 */
export interface NodeBuild { id: string; status: "current" | "outdated" | "updating" }

export interface RemoteNode {
  readonly id: string;
  /** Whether a negotiated connection of the node is open now. */
  readonly connected: boolean;
  /** The build it runs while connected, or was told to replace; null from source (no build announced), or
   * when it has not said hello since it last disconnected. */
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
 * The process's node hub (`nodes/node-hub.ts`, `ServerProcess.nodes`): the negotiated connection of every
 * connected node (by the node ID it announced), kept across reloads of the app. No node is special. Product
 * code and session runtimes call a node directly through `get`.
 */
export interface NodeHub {
  /** Serves one node connection (`LOCAL_LINK` options by default); once it negotiates `node.hello` for a
   * known node ID, after authenticating as that node if `options.authenticate`, it is that node's link. */
  accept(socket: NodeSocket, options?: AcceptOptions): void;
  /** The node `nodeId` (whether or not it is connected). */
  get(nodeId: string): RemoteNode;
  /** Closes node `nodeId`'s link, if it has one (its calls in flight fail with outcome unknown). */
  disconnect(nodeId: string): void;
  /** Process exit: closes every node connection (its calls in flight fail with outcome unknown) and
   * refuses later ones. */
  close(): Promise<void>;
}

/** One app's state (ADR-029): the process it runs in (`process`: the database, browser connections, node
 * hub, open sessions, credential locks and frontend directory) and what the app builds for itself, replaced
 * on every reload: its node bundle. Routes, ws handlers and models are served with it. */
export interface AppState {
  readonly process: ServerProcess;
  /** `/nodes/*`: the install script, manifest and bundle this app built (node-bundle/delivery.ts). */
  nodeBundle: NodeBundleDelivery;
}

/** How the current app answers a node bundle's hello (ADR-025): serve it (on the app's build, `current`, or
 * on another because the app has none to offer, `outdated`), tell it to update to the app's build, or fail
 * the hello for now because the app's build is not ready (the node redials). */
export type HelloBuild =
  | { kind: "serve"; status: "current" | "outdated" }
  | { kind: "update"; update: BuildUpdate }
  | { kind: "not_ready"; message: string };

/**
 * What the process's node hub asks of the current app (`App.hub`): product code, which hot reloads, so the
 * hub reaches it per use, `(await process.app(signal)).hub.…`. Answers cross as values, never as errors.
 */
export interface HubApp {
  /** The key a connection authenticating as node `nodeId` must prove it holds (base64url of the raw Ed25519
   * key): null for an unknown or never-paired node. A revoked or removed node keeps its key. */
  publicKey(nodeId: string): string | null;
  /** Why node `nodeId`'s hello is refused (it is unknown, removed or revoked: the node stops redialing), or
   * null to serve it. */
  refusal(nodeId: string): string | null;
  /** The answer to node `nodeId`'s hello announcing node bundle `buildId`, against this app's build. */
  helloBuild(nodeId: string, buildId: string): Promise<HelloBuild>;
  /** Tells browsers node `nodeId` as it is now (`Nodes.publish`): it got or lost its link, or was told to
   * update. */
  publish(nodeId: string): void;
}

/**
 * What the current app offers process-owned code (ADR-029): the node hub's questions about the nodes it links
 * (`hub`), and, for the session runtimes the process keeps, handlers for run lifecycle and the Reins tools:
 * product code that hot reloads. The app registers it with the process when it starts
 * (`ServerProcess.registerApp`) and unregisters it when it stops. A runtime or the hub reaches it per call,
 * `(await process.app(signal)).…`, and never keeps one: a runtime built by an older app calls a newer one
 * through this, so keep it small; a change that breaks it needs a restart.
 */
export interface App {
  /** What the node hub asks of this app. */
  readonly hub: HubApp;
  /** Run lifecycle (`sessions/session-runs.ts`). */
  runStarted(sessionId: string, runId: string): void;
  /** Resolves once applied (a child's report steered to its parent first). */
  runSettled(report: SessionSettled): Promise<void>;
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

/** The per-provider locks of the server's credential store, which serializes a provider's reads-and-writes
 * (an OAuth refresh rotates its refresh token). The process owns it so that every user of the store (an
 * app's routes and model catalog, every session's runtime, whichever app built it) takes the same lock;
 * the store itself is app code (`DbCredentialStore` in `pi/credential-store.ts`, over this). */
export interface CredentialLocks {
  /** Runs `work` once the provider's earlier work is done. */
  run<T>(providerId: string, work: () => Promise<T>): Promise<T>;
}

/**
 * What the process owns (ADR-029), created once by `server-process.ts` and passed whole to each app
 * (`start` in `server.ts`, `AppState.process`) and kept by session runtimes and the node hub. Only it
 * outlives an app: a session runtime or the hub may keep it, never an `AppState` or an `App`, and reaches the
 * app only through `app()` at each call. A change to it needs a restart.
 */
export interface ServerProcess {
  /** The database connection: opened once (with its pragmas); each app migrates it, none closes it. */
  readonly db: Database;
  /** Sends a serialized frame to every browser connection (the process registers them: they outlive
   * apps). Typed messages: `createBroadcast` (`models/broadcast.ts`). */
  broadcast(frame: string): void;
  readonly sessions: OpenSessions;
  /** The node hub: every node's link, kept across apps (a reload does not drop them; nodes redial only when
   * the process restarts). Its local socket listener is the process owner's (`server-process.ts`). */
  readonly nodes: NodeHub;
  /** `/nodes/link`: the WebSocket links of remote nodes, which the hub serves. The app's route upgrades a
   * request through it; the socket's handlers are the process's, so no app's stop closes it. */
  readonly nodeLinks: NodeLinks;
  /** The credential store's per-provider locks. */
  readonly credentialLocks: CredentialLocks;
  /** The current app. During a reload's gap (and before the first app) it waits for the next one, until `signal` aborts (rejecting
   * with its reason) or `APP_WAIT_MS` passes (rejecting with an error named `NoApp`). */
  app(signal?: AbortSignal): Promise<App>;
  /** An app starts: runtimes earlier apps built are closed at once when idle and retired otherwise.
   * Returns its unregistration (its `stop`), after which `app()` waits for the next one. */
  registerApp(app: App): () => void;
  readonly frontendDir: string;
}

/** One app's state: the process's, and the node bundle the app serves. */
export function createAppState(serverProcess: ServerProcess, nodeBundle: NodeBundleDelivery): AppState {
  return { process: serverProcess, nodeBundle };
}
