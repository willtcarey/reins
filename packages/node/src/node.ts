import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLICATION_ERROR, INTERNAL_ERROR, MAX_LIVE_SESSIONS, NodeRejection, NotConnected, serverCallRejection, RpcFailure, MAX_LISTED_SKILLS, type LaneSeed, type NodeSessionBinding, type SessionRuntime, type AttachmentStore, type ProjectCreateTask, type ProjectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type SessionEventReport, type SessionSettled, type SessionStarted, type AgentRuntimeEvent, type SessionInput, type NodeCommandHandlers, type ReinsToolCalls } from "@reins/node-protocol";
import { buildNodeRuntime, NodeModelNotFoundError, type EmitSessionEvent, type NodeRuntimePolicy, type ReportLifecycle, type RuntimeAttachments } from "./runtime/build.js";
import { PauseGate } from "./runtime/pause-gate.js";
import { createRemoteCredentialStore, NO_SERVER_MESSAGE, type CredentialServer } from "./credentials.js";
import { ToolCallNotRun, ToolCallOutcomeUnknown } from "./runtime/reins-tools.js";
import type { AgentHarnessPiRuntime } from "./runtime/pi-runtime.js";
import { ensureBranchCheckedOut } from "./runtime/git.js";
import { AttachmentCache, hydratePrompt, materializePromptAttachments, type FetchAttachment } from "./node-attachments.js";
import { referenceInlineImages, toolImageReferences, type UploadAttachment } from "./runtime/tool-images.js";
import { RemoteStorage, type StorageServer } from "./remote-storage.js";
import { ReinsResourceLoader } from "./resources/loader.js";
import { sendableEvent } from "./session-events.js";
import { listDirectory, partialWrites, readFile, runProcess, writeFile } from "./checkout.js";

/** Server-owned calls over a connection; calls may wait for negotiation and reject if it fails.
 * Session storage (`storage.*`) and provider credentials (`credentials.*`) are served by the server too:
 * a node holds no session state and needs no credential configuration of its own. */
export interface NodeServer extends CredentialServer, StorageServer {
  started(input: SessionStarted): Promise<void>;
  settled(input: SessionSettled): Promise<void>;
  fetchAttachment: FetchAttachment;
  /** Uploads node-created image bytes under their node-assigned ID (idempotent for the same ID and content). */
  storeAttachment(input: AttachmentStore & { data: Uint8Array }): Promise<void>;
  event(input: SessionEventReport): void;
  /** Agent tool calls for one session; never retried automatically (execute and createTask have side effects). */
  executeScript(input: ScriptExecute, signal?: AbortSignal): Promise<ScriptExecuteResult>;
  searchScript(input: ScriptSearch, signal?: AbortSignal): Promise<ScriptSearchResult>;
  createTask(input: ProjectCreateTask, signal?: AbortSignal): Promise<ProjectCreateTaskResult>;
}

/**
 * One stateless node (ADR-015). Each session command is its own method, taking and returning its wire
 * params/result (`connectNode` serves them as-is). A definite rejection throws `NodeRejection`
 * (`invalid_request`; `busy`; `unavailable`, retryable); any other exception is a node failure, sent as
 * `internal`. The node keeps only open runtimes and caches in memory: every session command carries the
 * binding (and an opening command the task branch, lane seed and runtime configuration) the runtime is
 * opened with, and Pi reads and commits the session through the server. Replays converge on Pi's own state on the server (see
 * node-contract.md *Replay idempotency*).
 */
export interface Node extends NodeCommandHandlers {
  /**
   * Holds every run at its next pause point (ADR-021) and resolves `paused` once cutting the node off
   * would lose nothing: no admission or tool call in flight, every run held, every lifecycle report
   * delivered. Commands are still served: input is admitted and its run held before its first request.
   * The runs stay held. At `timeoutMs` it resolves anyway with `force`; without, it releases the runs and
   * resolves not paused. `blocking` names the sessions it was still waiting for.
   */
  pause(options: { timeoutMs: number; force?: boolean }): Promise<{ paused: boolean; blocking: string[] }>;
  /**
   * The one teardown (process shutdown on SIGTERM/SIGINT, a reload, or a test): refuses new commands,
   * then closes every live runtime without aborting its run. Pause first, so nothing is cut off, and close
   * the connection: a run left in Pi's storage is resumed by the server when a node next connects.
   */
  shutdown(): Promise<void>;
  /** The newest attached connection serves server calls; detach when it closes. Runtimes outlive a
   * connection: a run keeps going through a quick redial (a server handler reload), its storage calls
   * and reports waiting for the next connection (see `NodeOptions.reconnectWaitMs`). */
  attach(server: NodeServer): () => void;
  /** Sessions with a run in progress, announced in `node.hello` so the server resumes the others it
   * still sees running on this node (they lost their runs; ADR-021). */
  liveSessions(): string[];
}

/**
 * TEST SEAM ONLY: live runtime access for node-package and backend tests. The server never holds or
 * calls a node runtime; it reads session state from its own storage and lifecycle reports, so it works
 * unchanged with the node in another process. Production code must not import this.
 */
export interface NodeRuntimesForTesting {
  has(sessionId: string): boolean;
  open(sessionId: string, target: RuntimeTarget): Promise<AgentHarnessPiRuntime>;
  close(sessionId: string): Promise<void>;
}
const testSeams = new WeakMap<Node, NodeRuntimesForTesting>();
/** See `NodeRuntimesForTesting`: tests only. */
export function nodeRuntimesForTesting(node: Node): NodeRuntimesForTesting {
  const seam = testSeams.get(node);
  if (!seam) throw new Error("Not a started node");
  return seam;
}

interface OpenRuntime { runtime: AgentHarnessPiRuntime; binding: string }
interface RuntimeLifecycle extends ReportLifecycle { storageFailed(error: unknown): void }
/** What an opening command carries to open the session's runtime with. */
export interface RuntimeTarget { binding: NodeSessionBinding; branch: string | null; lane: LaneSeed; runtime: SessionRuntime }

/** What restarts the node for `node.reload` (its process owner, under the supervisor). */
export interface NodeReloader {
  /** Throws when the node's new code does not build. */
  check(): Promise<void>;
  /** Ends the node once its runs are paused; something else starts it again on its new code. */
  restart(): void;
  /** How long the reload waits for the runs to pause: `RELOAD_DRAIN_TIMEOUT_MS` by default. */
  drainTimeoutMs?: number;
}

export interface NodeOptions {
  /** How long a server call that could not be sent (no negotiated connection) waits for the node to
   * reconnect before it fails: `RECONNECT_WAIT_MS` by default. */
  reconnectWaitMs?: number;
  /** Serves `node.reload`; a node without it refuses (nothing would restart it). */
  reload?: NodeReloader;
  /** The node's own files, none of them durable: the bytes of `fs.write`s not finished yet. A new
   * temporary directory by default, which `shutdown` removes (the node process passes `~/.reins` or
   * `REINS_NODE_DATA_DIR`). */
  dataDir?: string;
}
/** Covers a server handler reload or a server restart; a run's storage calls wait this long for the
 * node to reconnect. */
export const RECONNECT_WAIT_MS = 30_000;
/** How long a reload waits for every run to reach a pause point before it is cancelled (or, forced, cuts
 * off what is still in flight). */
export const RELOAD_DRAIN_TIMEOUT_MS = 60_000;
/** How often a pause checks whether anything is still in flight. */
const PAUSE_POLL_MS = 10;

/** Starts a node. Every call is a new node. Takes no in-process server dependency: everything the node
 * needs from the server, session storage and credentials included, crosses the attached connection. */
export function startNode({ reconnectWaitMs = RECONNECT_WAIT_MS, dataDir: givenDataDir, reload: reloader }: NodeOptions = {}): Node {
  const dataDir = givenDataDir ?? mkdtempSync(join(tmpdir(), "reins-node-"));
  const partials = partialWrites(dataDir);
  // Writes a previous run of the node left unfinished.
  partials.clear();
  let running = true;
  // Closed while the node pauses (a reload or shutdown): runs wait at their next pause point.
  const pauseGate = new PauseGate();
  let reloading = false;
  const servers: NodeServer[] = [];
  /** Resolved (and replaced) whenever a connection attaches or the node shuts down. */
  let changed = Promise.withResolvers<void>();
  const connectionChanged = () => { changed.resolve(); changed = Promise.withResolvers<void>(); };
  /**
   * Runs `call` on the newest attached connection. A call that could not be sent (no connection
   * attached, or one that closed or never negotiated: `NotConnected`) waits for another connection to
   * attach and is sent there, for up to `reconnectWaitMs` in all; then it fails. A call that was sent
   * is not sent again unless `resend` (the server recognises a repeat): then one whose reply was lost
   * (outcome unknown) is sent again on the next connection, within the same wait. A refusal rejects as it
   * came.
   */
  const connected = async <T>(call: (connection: NodeServer) => Promise<T>, { resend = false } = {}): Promise<T> => {
    const deadline = Date.now() + reconnectWaitMs;
    for (;;) {
      const connection = servers.at(-1);
      const next = changed.promise;
      try {
        if (!connection) throw new NotConnected("Reins server connection unavailable");
        return await call(connection);
      } catch (error) {
        const retry = error instanceof NotConnected || (resend && error instanceof RpcFailure && error.outcome === "unknown");
        if (!retry || !running) throw error;
        // Another connection attached meanwhile: send there at once.
        if (servers.at(-1) !== connection && servers.length) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([next.then(() => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), remaining); })]);
        clearTimeout(timer);
        if (timedOut || !running) throw error;
      }
    }
  };
  // Every Pi model runtime this node builds reads credentials from the server; a miss made while no
  // connection is attached waits for one like any server call.
  const credentialCall = async <T>(call: (connection: NodeServer) => Promise<T>): Promise<T> => {
    try { return await connected(call); }
    catch (error) { throw error instanceof NotConnected ? new Error(NO_SERVER_MESSAGE, { cause: error }) : error; }
  };
  const credentialServer: CredentialServer = {
    getCredential: (providerId, signal) => credentialCall(connection => connection.getCredential(providerId, signal)),
    refreshCredential: (providerId, signal) => credentialCall(connection => connection.refreshCredential(providerId, signal)),
    listCredentials: signal => credentialCall(connection => connection.listCredentials(signal)),
  };
  const credentials = createRemoteCredentialStore(() => credentialServer);
  // Sessions whose runtime saw a storage call fail (a refused commit, a lost link). Pi faults its harness
  // on any storage error, and after a commit whose outcome is unknown its in-memory state may not match
  // the server's copy: the runtime is closed and reopened from the server before its next command.
  const stale = new Set<string>();
  /** One runtime's storage on the server: a failed call marks the session stale and settles that
   * runtime's run (see `reporter`). */
  const runtimeStorage = (sessionId: string, lifecycle: RuntimeLifecycle): StorageServer => {
    const failed = async <T>(call: () => Promise<T>): Promise<T> => {
      try { return await call(); }
      catch (error) {
        stale.add(sessionId);
        lifecycle.storageFailed(error);
        throw error;
      }
    };
    return {
      readStorage: input => failed(() => connected(connection => connection.readStorage(input))),
      // A commit keeps its `commitId` when resent: the server answers a repeat of the one it applied last.
      commitStorage: input => failed(() => connected(connection => connection.commitStorage(input), { resend: true })),
    };
  };
  // A session's lifecycle reports go out one at a time in occurrence order, over whichever connection is
  // attached when each is sent (waiting for one like any server call); one whose reply was lost is resent
  // on the next connection (a repeated start of the run in progress applies nothing; a settlement keeps
  // its `reportId`). A session with a report still to deliver is listed as live, so the server does not
  // treat its run as lost meanwhile. One that cannot be delivered within the wait is lost: the server
  // resumes (or settles) a run it still sees running when this node next connects without it.
  const reportChains = new Map<string, Promise<void>>();
  const sendReport = (sessionId: string, send: () => Promise<void>) => {
    const run = (reportChains.get(sessionId) ?? Promise.resolve()).then(send)
      .catch((error: unknown) => console.warn(`Lifecycle report for ${sessionId} lost:`, error instanceof Error ? error.message : error));
    reportChains.set(sessionId, run);
    void run.finally(() => { if (reportChains.get(sessionId) === run) reportChains.delete(sessionId); });
  };
  /** One runtime's lifecycle reports. Pi faults its harness on a storage error and never ends that run
   * (no `run_end`), so the node settles it then (failed) and ignores anything the faulted runtime reports
   * after; with the link up the server would otherwise see it running until this node next connects. A
   * runtime reopened later may resume the same run, and its reports go out as usual. */
  const reporter = (sessionId: string): RuntimeLifecycle => {
    let openRun: string | undefined;
    let faulted = false;
    return {
      started: runId => {
        if (faulted) return;
        openRun = runId;
        sendReport(sessionId, () => connected(connection => connection.started({ sessionId, runId }), { resend: true }));
      },
      settled: report => {
        if (faulted) return;
        openRun = undefined;
        const reportId = crypto.randomUUID();
        sendReport(sessionId, () => connected(connection => connection.settled({ sessionId, reportId, ...report }), { resend: true }));
      },
      storageFailed: error => {
        if (faulted) return;
        faulted = true;
        if (openRun === undefined) return;
        const message = `Session storage failed: ${error instanceof Error ? error.message : String(error)}`;
        const runId = openRun;
        const reportId = crypto.randomUUID();
        sendReport(sessionId, () => connected(connection => connection.settled({ sessionId, runId, reportId, status: "failed", error: { message }, metadata: { model: null, thinkingLevel: null }, tipId: null }), { resend: true }));
      },
    };
  };
  const attachments = new AttachmentCache();
  const fetchAttachment: FetchAttachment = async (sessionId, attachmentId) => {
    try { return await connected(connection => connection.fetchAttachment(sessionId, attachmentId)); }
    catch (error) { throw serverCallRejection(error, "Attachment fetch failed"); }
  };
  // An upload is idempotent (the same ID and content is acknowledged as stored), so one restarted on a new
  // connection after an earlier chunk went out on a closed one stores the same bytes.
  const upload: UploadAttachment = (sessionId, attachmentId, { data, mimeType, byteSize, sha256, filename, width, height }) =>
    connected(connection => connection.storeAttachment({ sessionId, attachmentId, mimeType, byteSize, sha256, data,
      ...(filename !== undefined ? { filename } : {}), ...(width !== undefined && height !== undefined ? { width, height } : {}) }));
  const runtimeAttachments = (sessionId: string): RuntimeAttachments => ({
    hydratePrompt: (id, content) => hydratePrompt(attachments, id, content, fetchAttachment),
    referenceToolImages: toolImageReferences(attachments, upload, sessionId),
  });
  const toolCall = async <T>(call: (connection: NodeServer) => Promise<T>): Promise<T> => {
    const connection = servers.at(-1);
    if (!connection) throw new ToolCallNotRun("Reins server connection unavailable");
    try { return await call(connection); }
    catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      if (error.code === APPLICATION_ERROR) throw new Error(error.message, { cause: error });
      if (error.outcome === "unknown" || error.code === INTERNAL_ERROR) throw new ToolCallOutcomeUnknown(error.message);
      throw new ToolCallNotRun(error.message);
    }
  };
  const toolCalls = (sessionId: string): ReinsToolCalls => ({
    executeScript: (code, signal) => toolCall(connection => connection.executeScript({ sessionId, code }, signal)),
    searchScript: (query, signal) => toolCall(connection => connection.searchScript({ sessionId, query }, signal)),
    createTask: (input, signal) => toolCall(connection => connection.createTask({ sessionId, ...input }, signal)),
  });
  // Per-session sequence for this node instance; events emitted with no attached connection are
  // dropped but still consume a seq, so the server sees the gap.
  const eventSeqs = new Map<string, number>();
  const emitter = (sessionId: string): EmitSessionEvent => (event: AgentRuntimeEvent) => {
    const seq = (eventSeqs.get(sessionId) ?? 0) + 1;
    eventSeqs.set(sessionId, seq);
    const connection = servers.at(-1);
    const emittedAt = Date.now();
    if (connection) connection.event({ sessionId, seq, emittedAt, event: sendableEvent(event) });
  };
  // Opening and closing one session's runtime never overlap.
  const tails = new Map<string, Promise<unknown>>();
  const serialized = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(work);
    tails.set(sessionId, run);
    void run.finally(() => { if (tails.get(sessionId) === run) tails.delete(sessionId); }).catch(() => undefined);
    return run;
  };
  const runtimes = new Map<string, OpenRuntime>();
  const started = () => { if (!running) throw new Error("Node stopped"); };
  /** Closes the session's runtime if one is open and drops its cached attachments; returns whether one
   * was open. A run is aborted, or with `suspend` left pending for the next runtime to resume (see
   * `AgentHarnessPiRuntime.suspend`). Call serialized. */
  const closeRuntime = async (sessionId: string, { suspend = false } = {}): Promise<boolean> => {
    const live = runtimes.get(sessionId);
    if (!live) return false;
    runtimes.delete(sessionId);
    // A harness a failed commit faulted rethrows its fault from close: it is released all the same.
    try { await (suspend ? live.runtime.suspend() : live.runtime.close()); }
    catch (error) { console.warn(`Closing session ${sessionId}'s runtime failed:`, error instanceof Error ? error.message : error); }
    finally { attachments.drop(sessionId); stale.delete(sessionId); }
    return true;
  };
  /**
   * The session's runtime, opened on first use from what the command carries: the binding (where it
   * runs and Pi's session identity), the task branch (checked out in the bound workspace before Pi is
   * built), the lane seed (Pi's main lane is created from it, through the server, when the session has
   * none yet) and the runtime configuration (the system prompt and active tools Pi is opened with; a
   * runtime already open keeps its own until it is reopened). A runtime open under another binding (the session was moved to another source on this
   * node) is closed and reopened when idle, and refused `busy` while it runs; one a failed commit left
   * stale is closed and reopened. `model` validates and seeds a model the caller is about to
   * set (`session.setModel`).
   */
  const openRuntime = (sessionId: string, { binding, branch, lane, runtime: configuration }: RuntimeTarget, model?: NodeRuntimePolicy["model"]): Promise<AgentHarnessPiRuntime> => {
    started();
    const key = JSON.stringify(binding);
    const reusable = (current: OpenRuntime | undefined) => current?.binding === key && !stale.has(sessionId);
    const cached = runtimes.get(sessionId);
    if (reusable(cached)) return Promise.resolve(cached!.runtime);
    return serialized(sessionId, async () => {
      started();
      const current = runtimes.get(sessionId);
      if (reusable(current)) return current!.runtime;
      if (current) {
        // A stale runtime is dead whatever it is doing (Pi faulted its harness).
        if (current.runtime.isStreaming() && !stale.has(sessionId)) throw new NodeRejection("busy", `Session ${sessionId} is running under another binding on this node`);
        await closeRuntime(sessionId);
      }
      if (branch) await ensureBranchCheckedOut(binding.cwd, branch);
      const policy: NodeRuntimePolicy = { runtime: configuration, lane, credentials, pauseGate, ...(model ? { model } : {}) };
      // Commits Pi makes without the `after_tool` hook (a checkpointed result republished on recovery, a
      // hook cut short by abort) get their inline images uploaded here, before the commit is sent.
      const lifecycle = reporter(sessionId);
      const storage = new RemoteStorage(sessionId, runtimeStorage(sessionId, lifecycle), writes => referenceInlineImages(attachments, upload, sessionId, writes));
      const runtime = await buildNodeRuntime(sessionId, binding, storage, policy, runtimeAttachments(sessionId), emitter(sessionId), lifecycle, toolCalls(sessionId));
      runtimes.set(sessionId, { runtime, binding: key });
      return runtime;
    });
  };
  /** Runs `use` on the session's runtime. When a storage call failed under it (e.g. the link dropped
   * mid-admission, faulting Pi's harness), the runtime is reopened from the server's copy and `use` runs
   * once more: every command converges on replay (see node-contract.md *Replay idempotency*). */
  const withRuntime = async <T>(sessionId: string, target: RuntimeTarget, use: (runtime: AgentHarnessPiRuntime) => Promise<T>, model?: NodeRuntimePolicy["model"]): Promise<T> => {
    try { return await use(await openRuntime(sessionId, target, model)); }
    catch (error) {
      if (!stale.has(sessionId)) throw error;
      return use(await openRuntime(sessionId, target, model));
    }
  };
  /** Closes every runtime, leaving its run pending (shutdown). */
  const suspendAll = () => Promise.allSettled([...runtimes.keys()].map(sessionId => serialized(sessionId, () => closeRuntime(sessionId, { suspend: true }))));
  /** Sessions a pause still waits for: a runtime with something in flight, or a report to deliver. */
  const unpaused = () => [...new Set([
    ...[...runtimes].filter(([, { runtime }]) => !runtime.isPaused()).map(([sessionId]) => sessionId),
    ...reportChains.keys(),
  ])];
  const admit = (op: "prompt" | "steer") => async ({ sessionId, binding, branch, lane, runtime: configuration, clientId, content, sourceSessionId }: SessionInput) => {
    started();
    // Prompt/steer attachments are cached on the node before Pi admission.
    await materializePromptAttachments(attachments, sessionId, content, fetchAttachment);
    const options = { reinsId: clientId, ...(sourceSessionId ? { metadata: { sourceSessionId } } : {}) };
    await withRuntime(sessionId, { binding, branch, lane, runtime: configuration }, async runtime => { await (op === "prompt" ? runtime.prompt(content, options) : runtime.steer(content, options)); });
    // A replay is recognized by Pi's durable reinsId (`findAdmitted`) and answered, not re-admitted.
    return { inputId: clientId };
  };
  const node: Node = {
    prompt: admit("prompt"),
    steer: admit("steer"),
    async setModel({ sessionId, binding, branch, lane, runtime: configuration, provider, modelId, thinkingLevel }) {
      started();
      const model = { provider, modelId, thinkingLevel: thinkingLevel ?? null };
      try {
        // Opening validates the new model, so a lane whose stored model is no longer available can
        // still be repaired.
        await withRuntime(sessionId, { binding, branch, lane, runtime: configuration }, runtime => runtime.setModel(model), model);
      } catch (error) {
        if (error instanceof NodeModelNotFoundError) throw new NodeRejection("invalid_request", error.message);
        throw error;
      }
      // The selection is absolute: a replay applies the same value again.
      return { modelSet: true };
    },
    async abort({ sessionId }) {
      started();
      // Only a live runtime can have a run to abort: never open Pi (or check out a branch) to abort.
      // `aborted` reports whether the runtime was busy when the abort arrived.
      const live = runtimes.get(sessionId)?.runtime;
      const busy = live?.isStreaming() ?? false;
      await live?.abort();
      return { aborted: busy };
    },
    async resumePending({ sessionId, binding, branch, lane, runtime: configuration }) {
      started();
      // Replay-safe: an input may have joined the pending operation first (see `resumePendingOperation`).
      return { started: await withRuntime(sessionId, { binding, branch, lane, runtime: configuration }, runtime => runtime.resumePendingOperation()) };
    },
    async close({ sessionId }) {
      started();
      // The session no longer runs here (it was moved or deleted): a run is aborted, the runtime closed.
      return { closed: await serialized(sessionId, () => closeRuntime(sessionId)) };
    },
    async listSkills({ cwd }) {
      started();
      // The source's checkout, as the server resolves it; read-only discovery (as prompt expansion does).
      if (!existsSync(cwd)) throw new NodeRejection("not_found", `Source checkout not found: ${cwd}`);
      const loader = new ReinsResourceLoader({ cwd });
      loader.load();
      return {
        skills: loader.skills.filter(skill => skill.name.length > 0 && skill.name.length <= 128).slice(0, MAX_LISTED_SKILLS)
          .map(skill => ({ name: skill.name, description: skill.description.slice(0, 4096) })),
      };
    },
    async runProcess(input) { started(); return runProcess(input); },
    async listDirectory(input) { started(); return listDirectory(input); },
    async readFile(input) { started(); return readFile(input); },
    async writeFile(input) { started(); return writeFile(input, partials); },
    // A server-side key change or logout: the provider's next read asks the server.
    credentialsChanged({ providerId }) { credentials.invalidate(providerId); },
    // A stale runtime's run cannot finish (its harness is faulted), so it is not live; one whose reports
    // are still to be delivered is (its settlement is on its way).
    liveSessions: () => [...new Set([
      ...[...runtimes].filter(([sessionId, { runtime }]) => runtime.isStreaming() && !stale.has(sessionId)).map(([sessionId]) => sessionId),
      ...reportChains.keys(),
    ])].slice(0, MAX_LIVE_SESSIONS),
    async pause({ timeoutMs, force = false }) {
      pauseGate.close();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const blocking = unpaused();
        if (blocking.length === 0) return { paused: true, blocking };
        if (Date.now() >= deadline) {
          if (!force) pauseGate.open();
          return { paused: force, blocking };
        }
        await new Promise(resolve => setTimeout(resolve, PAUSE_POLL_MS));
      }
    },
    async reload({ force }) {
      started();
      if (!reloader) throw new NodeRejection("unavailable", "Nothing would restart this node (it is not supervised): restart it to load new code");
      if (reloading) return { scheduled: true };
      try { await reloader.check(); }
      catch (error) { throw new NodeRejection("invalid_request", `The node's new code does not build: ${error instanceof Error ? error.message : String(error)}`); }
      if (reloading) return { scheduled: true };
      reloading = true;
      const timeoutMs = reloader.drainTimeoutMs ?? RELOAD_DRAIN_TIMEOUT_MS;
      // Answered before the reload: the caller's own tool call is one of the things it waits for.
      void node.pause({ timeoutMs, ...(force ? { force } : {}) }).then(({ paused, blocking }) => {
        if (paused) { reloader.restart(); return; }
        reloading = false;
        console.warn(`[node] reload cancelled: still busy after ${timeoutMs}ms: ${blocking.join(", ")}`);
      });
      return { scheduled: true };
    },
    async shutdown(): Promise<void> {
      running = false;
      // Calls waiting for a connection fail now.
      connectionChanged();
      await Promise.allSettled(tails.values());
      await suspendAll();
      await Promise.allSettled(reportChains.values());
      if (givenDataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
    },
    attach(connection: NodeServer): () => void {
      servers.push(connection);
      // A new connection may be a different server view (logout, rotated key): re-read credentials.
      // Not on detach: a reconnect keeps cached credentials until it attaches.
      credentials.invalidate();
      connectionChanged();
      return () => {
        const index = servers.indexOf(connection);
        if (index >= 0) servers.splice(index, 1);
      };
    },
  };
  testSeams.set(node, {
    has: sessionId => runtimes.has(sessionId),
    open: (sessionId, target) => openRuntime(sessionId, target),
    async close(sessionId) {
      const live = runtimes.get(sessionId);
      if (!live) return;
      if (live.runtime.isStreaming()) throw new Error(`Cannot close active node runtime: ${sessionId}`);
      await serialized(sessionId, () => closeRuntime(sessionId));
    },
  });
  return node;
}
