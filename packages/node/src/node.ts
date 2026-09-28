import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { completeNodeReport, createOutboxDrain, dropNodeSession, nodeSessionBinding, nodeSessionTask, openNodeStorage, pendingOutboxSessions, provisionNodeSession, recordNodeReport, releaseUnreadReports, type NodeOutboxDelivery, type NodeOutboxItem } from "./storage.js";
import { sessionEvent, APPLICATION_ERROR, nodeError, NodeRejection, serverCallRejection, RpcFailure, mapContentImages, MAX_LISTED_SKILLS, type NodeSessionBinding, type AttachmentStore, type ProjectCreateTask, type ProjectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type SessionEvent, type SessionEventReport, type SessionSettled, type SessionStarted, type AgentRuntimeEvent, type SessionInput, type SessionSnapshot, type NodeCommandHandlers, type ReinsToolCalls } from "@reins/node-protocol";
import { buildNodeRuntime, NodeModelNotFoundError, type EmitSessionEvent, type NodeRuntimePolicy, type ReportLifecycle } from "./runtime/build.js";
import { createRemoteCredentialStore, type CredentialServer } from "./credentials.js";
import { ToolCallNotRun, ToolCallOutcomeUnknown } from "./runtime/reins-tools.js";
import type { AgentHarnessPiRuntime } from "./runtime/pi-runtime.js";
import { ensureBranchCheckedOut } from "./runtime/git.js";
import { createMainLane, storedLaneModel } from "./runtime/lane.js";
import { createPiModelRuntime } from "./runtime/context.js";
import { PiStorageAdapter } from "@reins/pi-sql-storage";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { materializePromptAttachments, type FetchAttachment } from "./node-attachments.js";
import { holdsHydratedCopy, hydrateNodeSession } from "./relocation.js";
import { ReinsResourceLoader } from "./resources/loader.js";

/** Server-owned calls over a connection; calls may wait for negotiation and reject if it fails.
 * Provider credentials are served by the server too (`credentials.*`): a node needs no credential
 * configuration of its own. */
export interface NodeServer extends CredentialServer {
  committed(input: { sessionId: string; startSeq: number; writesJson: string }): Promise<void>;
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
  /** One page of the server's copy of a session (session relocation). */
  snapshot(sessionId: string, fromSeq: number): Promise<SessionSnapshot>;
}

/**
 * One node over one node database. Each session command is its own method, taking and returning its
 * wire params/result (`connectNode` serves them as-is). A definite rejection throws `NodeRejection`
 * (`not_found`: the session's node data is missing; `invalid_request`; `busy`; `unavailable`, retryable);
 * any other exception (e.g. a binding mismatch) is a node failure, sent as `internal`. Replays converge on
 * each command's own state, not a per-command receipt (see node-contract.md *Replay idempotency*).
 */
export interface Node extends NodeCommandHandlers {
  /**
   * The one teardown (process shutdown on SIGTERM/SIGINT, or a test): refuses new commands, then aborts
   * every active run and closes every live runtime, so each run settles durably (its commits and
   * settlement wait in the outbox for the next connection) instead of being cut off mid-write. Close the
   * connection first and the node database after.
   */
  shutdown(): Promise<void>;
  /** The newest attached connection serves server calls; detach when it closes. Attaching replays pending reports. */
  attach(server: NodeServer): () => void;
}

/**
 * TEST SEAM ONLY: live runtime access for node-package and backend tests. The server never holds or
 * calls a node runtime; it reads session state from its own projections (activity from durable
 * lifecycle reports, its command outbox, the replica transcript), so it works unchanged with the node
 * in another process. Production code must not import this.
 */
export interface NodeRuntimesForTesting {
  has(sessionId: string): boolean;
  open(sessionId: string, binding: NodeSessionBinding): Promise<AgentHarnessPiRuntime>;
  close(sessionId: string): Promise<void>;
}
const testSeams = new WeakMap<Node, NodeRuntimesForTesting>();
/** See `NodeRuntimesForTesting`: tests only. */
export function nodeRuntimesForTesting(node: Node): NodeRuntimesForTesting {
  const seam = testSeams.get(node);
  if (!seam) throw new Error("Not a started node");
  return seam;
}

/** What a started node is doing right now; the dev reload (`dev-reload.ts`) restarts only an idle node. */
export interface NodeActivity {
  /** Live runtimes with a run admitting, starting or in progress. */
  activeRuns: number;
  /** Runtime openings and serialized session work (provision, hydrate, dropping a copy) in progress. */
  pendingWork: number;
}
const activities = new WeakMap<Node, () => NodeActivity>();
export function nodeActivity(node: Node): NodeActivity {
  const activity = activities.get(node);
  if (!activity) throw new Error("Not a started node");
  return activity();
}

const IMAGE_UNAVAILABLE = { type: "text", text: "[Image attachment unavailable]" } as const;
/** Session events never carry image bytes. Committed tool-result images are references (see
 * `runtime/tool-images.ts`); an image still inline in a live event (a partial tool result, or Pi's
 * in-memory copy of a result its storage adapter converted on commit) is replaced by a placeholder in
 * that event only. */
function sendableEvent(event: AgentRuntimeEvent): SessionEvent {
  const wire = sessionEvent.safeParse(event);
  if (wire.success) return wire.data;
  const placeholders = sessionEvent.safeParse(mapContentImages(event, block => typeof block.data === "string" ? IMAGE_UNAVAILABLE : block));
  // The event is invalid for another reason: send it as is and let the receiver drop it (logged there).
  return placeholders.success ? placeholders.data : event as SessionEvent; // eslint-disable-line typescript-eslint/consistent-type-assertions -- rejected by the receiver's schema
}

const MISSING_SESSION_MESSAGE = "This session's node data is missing. Start a new session.";

const isNotOwner = (data: unknown) => nodeError.safeParse(data).data?.code === "not_owner";

/** Starts a node over `db`, an open, migrated node database (`openNodeDb`) the caller owns and closes
 * after `shutdown()`. Every call is a new node. Takes no in-process server dependency: everything the
 * node needs from the server, credentials included, crosses the attached connection. */
export function startNode(db: Database): Node {
  // A new node instance has no reply read in flight; held settlements must not block their sessions.
  releaseUnreadReports(db, "The node restarted before the final reply was read");
  let running = true;
  const servers: NodeServer[] = [];
  // Every Pi model runtime this node builds reads credentials from the newest attached connection.
  const credentials = createRemoteCredentialStore(() => servers.at(-1));
  const server = () => {
    const current = servers.at(-1);
    if (!current) throw new Error("Server connection unavailable");
    return current;
  };
  const send = (sessionId: string, item: NodeOutboxItem) => {
    if (item.kind === "committed") return server().committed({ sessionId, startSeq: item.startSeq, writesJson: item.payload });
    if (item.kind === "attachment") return server().storeAttachment({ sessionId, ...item.attachment });
    return item.kind === "started" ? server().started({ sessionId, ...JSON.parse(item.payload) }) : server().settled({ sessionId, ...JSON.parse(item.payload) });
  };
  // Which copy of a session the node holds: bumped whenever a copy is dropped (hydrate replacing it,
  // `not_owner`), so a late rejection of an earlier copy's report never drops a newer copy.
  const copies = new Map<string, number>();
  const deliver: NodeOutboxDelivery = async (sessionId, item) => {
    const copy = copies.get(sessionId) ?? 0;
    try { await send(sessionId, item); }
    catch (error) {
      // The server moved the session to another owner: its reports can never be accepted here (the
      // accepted loss of a move), so drop the copy rather than retry them.
      if (error instanceof RpcFailure && isNotOwner(error.data)) void disown(sessionId, copy);
      throw error;
    }
  };
  const outbox = createOutboxDrain(db, deliver);
  // Delivery failure leaves reports pending for the next drain or attach.
  const drain = (sessionId: string) => { void outbox(sessionId).catch(() => undefined); };
  const reporter = (sessionId: string): ReportLifecycle => ({
    started: runId => { recordNodeReport(db, sessionId, "started", JSON.stringify({ runId })); drain(sessionId); },
    settled: (report, final) => {
      const id = recordNodeReport(db, sessionId, "settled", JSON.stringify(report), !final);
      drain(sessionId);
      void final?.then(value => { completeNodeReport(db, id, JSON.stringify(value)); drain(sessionId); })
        .catch((error: unknown) => console.error(`Failed to record settlement for ${sessionId}:`, error));
    },
  });
  const fetchAttachment: FetchAttachment = async (sessionId, attachmentId) => {
    try { return await server().fetchAttachment(sessionId, attachmentId); }
    catch (error) { throw serverCallRejection(error, "Attachment fetch failed"); }
  };
  const toolCall = async <T>(call: (connection: NodeServer) => Promise<T>): Promise<T> => {
    const connection = servers.at(-1);
    if (!connection) throw new ToolCallNotRun("Reins server connection unavailable");
    try { return await call(connection); }
    catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      if (error.code === APPLICATION_ERROR) throw new Error(error.message, { cause: error });
      if (error.outcome === "unknown" || error.code === -32603) throw new ToolCallOutcomeUnknown(error.message);
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
    if (connection) connection.event({ sessionId, seq, event: sendableEvent(event) });
  };
  // Pi's storage has no cross-harness conflict detection: provision's lane creation and runtime opening
  // for one session never overlap.
  const tails = new Map<string, Promise<unknown>>();
  const serialized = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(work);
    tails.set(sessionId, run);
    void run.finally(() => { if (tails.get(sessionId) === run) tails.delete(sessionId); }).catch(() => undefined);
    return run;
  };
  const runtimes = new Map<string, AgentHarnessPiRuntime>();
  const openings = new Map<string, Promise<AgentHarnessPiRuntime>>();
  const started = () => { if (!running) throw new Error("Node stopped"); };
  /** The session's stored binding, which must equal the command's; `not_found` when the node holds no copy. */
  const verify = (id: string, binding: NodeSessionBinding) => {
    const stored = nodeSessionBinding(db, id);
    if (!stored) throw new NodeRejection("not_found", MISSING_SESSION_MESSAGE);
    if (JSON.stringify(stored) !== JSON.stringify(binding)) throw new Error(`Node session binding mismatch: ${id}`);
    return stored;
  };
  /** Opens from node storage alone: the provisioned task snapshot and Pi's lane (model selection);
   * no server call. `model` validates and seeds a model the caller is about to set (`session.setModel`). */
  const openRuntime = async (sessionId: string, binding: NodeSessionBinding, model?: NodeRuntimePolicy["model"]): Promise<AgentHarnessPiRuntime> => {
    started();
    const stored = verify(sessionId, binding);
    const cached = runtimes.get(sessionId);
    if (cached) return cached;
    const pending = openings.get(sessionId);
    if (pending) return pending;
    const opening = serialized(sessionId, async () => {
      const task = nodeSessionTask(db, sessionId);
      // The session's task branch is checked out in the bound workspace before Pi is built.
      if (task) await ensureBranchCheckedOut(stored.cwd, task.branchName);
      const policy: NodeRuntimePolicy = { task, credentials, ...(model ? { model } : {}) };
      const runtime = await buildNodeRuntime(sessionId, stored,
        await openNodeStorage(db, sessionId, outbox), policy, db, emitter(sessionId), reporter(sessionId), toolCalls(sessionId));
      runtimes.set(sessionId, runtime);
      return runtime;
    });
    openings.set(sessionId, opening);
    try { return await opening; }
    finally { openings.delete(sessionId); }
  };
  /**
   * Provision invariant: idempotency comes from ordering, not one transaction. (1) The binding and
   * task snapshot are stored (an equal binding is a no-op, a different one rejects); (2) unless the
   * main lane already exists, Pi creates it with the provisioned model through its storage adapter.
   * There is no receipt: a replay (after a crash between the steps, a lost reply, or success) runs
   * again, and each step converges: the binding matches, the lane exists (no second write). A model the
   * node's registry does not know is rejected (`invalid_request`) before step 1, so a rejection leaves
   * nothing behind.
   */
  const provisionSession = ({ sessionId, binding, configuration }: Parameters<Node["provision"]>[0]) => serialized(sessionId, async () => {
    const selected = configuration.model;
    const models = selected ? await createPiModelRuntime({ credentials }) : undefined;
    const model = selected && models?.getModel(selected.provider, selected.modelId);
    // A replay whose lane already exists has converged even if the model has since become unknown.
    if (selected && !model && !(nodeSessionBinding(db, sessionId) && await storedLaneModel(new PiStorageAdapter(db, sessionId)))) {
      throw new NodeRejection("invalid_request", new NodeModelNotFoundError(selected.provider, selected.modelId).message);
    }
    provisionNodeSession(db, sessionId, binding, configuration.task);
    // No resolved model: no lane; opening fails "requires an explicit model" until session.setModel.
    if (!models || !model) return;
    const storage = await openNodeStorage(db, sessionId, outbox);
    try {
      if (!await storedLaneModel(storage)) await createMainLane(storage, sessionId, binding, models, model, configuration.thinkingLevel);
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  });
  const admit = (op: "prompt" | "steer") => async ({ sessionId, binding, clientId, content, sourceSessionId }: SessionInput) => {
    started();
    verify(sessionId, binding);
    // Prompt/steer attachments are cached on the node before Pi admission.
    await materializePromptAttachments(db, sessionId, content, fetchAttachment);
    const runtime = await openRuntime(sessionId, binding);
    const options = { reinsId: clientId, ...(sourceSessionId ? { metadata: { sourceSessionId } } : {}) };
    if (op === "prompt") await runtime.prompt(content, options);
    else await runtime.steer(content, options);
    // A replay is recognized by Pi's durable reinsId (`findAdmitted`) and answered, not re-admitted.
    return { inputId: clientId };
  };
  /** Closes the session's runtime (aborting a run only when `abort`) and deletes the local copy. Returns
   * false, dropping nothing, when a run is active and `abort` is false. Call serialized. */
  const discardCopy = async (sessionId: string, { abort }: { abort: boolean }): Promise<boolean> => {
    const live = runtimes.get(sessionId);
    if (live?.isStreaming()) {
      if (!abort) return false;
      await live.abort();
    }
    if (live) {
      runtimes.delete(sessionId);
      await live.close();
    }
    dropNodeSession(db, sessionId);
    copies.set(sessionId, (copies.get(sessionId) ?? 0) + 1);
    return true;
  };
  /** `not_owner` for a report of `copy`: the session was moved away from this node. Drops its pending
   * reports and its copy, so commands answer `not_found` until it is hydrated here again. */
  const disown = (sessionId: string, copy: number) => serialized(sessionId, async () => {
    if ((copies.get(sessionId) ?? 0) !== copy || !nodeSessionBinding(db, sessionId)) return;
    console.warn(`Session ${sessionId} is no longer owned by this node; dropping its local copy and undelivered reports`);
    await discardCopy(sessionId, { abort: true });
  }).catch((error: unknown) => console.error(`Failed to drop session ${sessionId}:`, error));
  const node: Node = {
    async provision(input) {
      started();
      await provisionSession(input);
      // Replication unavailability does not invalidate the durable local admission.
      await outbox(input.sessionId).catch(() => undefined);
      return { provisioned: true };
    },
    prompt: admit("prompt"),
    steer: admit("steer"),
    async setModel({ sessionId, binding, provider, modelId, thinkingLevel }) {
      started();
      verify(sessionId, binding);
      const model = { provider, modelId, thinkingLevel: thinkingLevel ?? null };
      try {
        // Opening validates the new model and seeds a lane Pi has not created yet, so a lane whose
        // stored model is no longer available can still be repaired.
        const runtime = runtimes.get(sessionId) ?? await openRuntime(sessionId, binding, model);
        await runtime.setModel(model);
      } catch (error) {
        if (error instanceof NodeModelNotFoundError) throw new NodeRejection("invalid_request", error.message);
        throw error;
      }
      // The selection is absolute: a replay applies the same value again.
      return { modelSet: true };
    },
    async abort({ sessionId, binding }) {
      started();
      verify(sessionId, binding);
      // Only a live runtime can have a run to abort: never open Pi (or check out a branch) to abort.
      // `aborted` reports whether the runtime was busy when the abort arrived.
      const live = runtimes.get(sessionId);
      const busy = live?.isStreaming() ?? false;
      await live?.abort();
      return { aborted: busy };
    },
    async resumePending({ sessionId, binding }) {
      started();
      verify(sessionId, binding);
      await (await openRuntime(sessionId, binding)).resumePendingOperation();
      return { started: true };
    },
    async hydrate(request) {
      started();
      // Serialized with provision and runtime opening: a replay that overlaps a slow first attempt waits
      // for it and then finds the identical copy.
      return serialized(request.sessionId, async () => {
        if (holdsHydratedCopy(db, request)) return { hydrated: true } as const;
        // A different copy (from an earlier stay on this node) is replaced wholesale. It is dropped before
        // the pull, so a failed hydrate leaves no stale copy for later commands to run on: they answer
        // `not_found` and the server hydrates again.
        if (nodeSessionBinding(db, request.sessionId) && !await discardCopy(request.sessionId, { abort: false })) {
          throw new NodeRejection("busy", `Session ${request.sessionId} has an active run on this node; hydrate refused`);
        }
        await hydrateNodeSession(db, server, request);
        return { hydrated: true } as const;
      });
    },
    async delete({ sessionId }) {
      started();
      // Deleted on the server: whatever this node holds for it goes, a run included (aborted). Serialized
      // like a hydrate; a node holding nothing answers the same.
      await serialized(sessionId, () => discardCopy(sessionId, { abort: true }));
      return { deleted: true };
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
    async shutdown(): Promise<void> {
      running = false;
      await Promise.allSettled(openings.values());
      await Promise.allSettled([...runtimes.values()].map(runtime => runtime.close()));
      runtimes.clear();
      // Settlement completion (`completeNodeReport`) follows the run's final reply asynchronously.
      await Promise.allSettled(tails.values());
    },
    attach(connection: NodeServer): () => void {
      servers.push(connection);
      // A new connection may be a different server view (logout, rotated key): re-read credentials.
      // Not on detach: a run keeps its cached credentials through a dropped link.
      credentials.invalidate();
      for (const sessionId of pendingOutboxSessions(db)) drain(sessionId);
      return () => {
        const index = servers.indexOf(connection);
        if (index >= 0) servers.splice(index, 1);
      };
    },
  };
  activities.set(node, () => ({
    activeRuns: [...runtimes.values()].filter(runtime => runtime.isStreaming()).length,
    pendingWork: openings.size + tails.size,
  }));
  testSeams.set(node, {
    has: sessionId => runtimes.has(sessionId),
    open: (sessionId, binding) => openRuntime(sessionId, binding),
    async close(sessionId) {
      const runtime = runtimes.get(sessionId);
      if (!runtime) return;
      if (runtime.isStreaming()) throw new Error(`Cannot close active node runtime: ${sessionId}`);
      try { await runtime.close(); }
      finally { runtimes.delete(sessionId); }
    },
  });
  return node;
}
