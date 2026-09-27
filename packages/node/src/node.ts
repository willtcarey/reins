import type { Database } from "bun:sqlite";
import type { NodeCommand, NodeResult, SessionConfiguration } from "./contract.js";
import { completeNodeReport, deliverNodeOutbox, getNodeDb, initializeNodeStorage, nodeAdmissionReceipt, nodeSessionBinding, nodeSessionTask, openNodeStorage, pendingOutboxSessions, provisionNodeSession, recordNodeAdmission, recordNodeReport, releaseUnreadReports, type NodeOutboxDelivery, type NodeSessionBinding } from "./storage.js";
import { buildNodeRuntime, NodeModelNotFoundError, type EmitSessionEvent, type NodeRuntimePolicy, type ReportLifecycle } from "./runtime/build.js";
import { createRemoteCredentialStore, type CredentialServer } from "./credentials.js";
import { sessionEvent, type AttachmentStore, type ProjectCreateTask, type ProjectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type SessionEvent, type SessionEventReport, type SessionSettled, type SessionStarted } from "./protocol/schema.js";
import { ToolCallNotRun, ToolCallOutcomeUnknown, type ReinsToolCalls } from "./runtime/reins-tools.js";
import type { AgentHarnessPiRuntime } from "./runtime/pi-runtime.js";
import { APPLICATION_ERROR } from "./protocol/errors.js";
import { RpcFailure } from "./protocol/peer.js";
import { ensureBranchCheckedOut } from "./runtime/git.js";
import { createMainLane, storedLaneModel } from "./runtime/lane.js";
import { createPiModelRuntime } from "./runtime/context.js";
import { PiStorageAdapter } from "./pi-storage.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { AttachmentMaterializationError, materializePromptAttachments, type FetchAttachment } from "./runtime/attachments.js";
import { mapContentImages } from "./protocol/event-images.js";
import type { AgentRuntimeEvent } from "./runtime/types.js";

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
}

export interface Node {
  stop(): void;
  send(input: NodeCommand, binding: NodeSessionBinding, commandId?: string): Promise<NodeResult>;
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

const instances = new WeakMap<Database, { node: Node; retain: () => void }>();
const MISSING_SESSION_MESSAGE = "This session's node data is missing. Start a new session.";

class ServerCallFailed extends Error {}
type NodeRejection = Extract<NodeResult, { ok: false }>["error"];

/** Takes no in-process server dependency: everything the node needs from the server, credentials
 * included, crosses the attached connection. */
export function startNode(): Node {
  const db = getNodeDb();
  const existing = instances.get(db);
  if (existing) {
    existing.retain();
    return existing.node;
  }
  initializeNodeStorage(db);
  // A new node instance has no reply read in flight; held settlements must not block their sessions.
  releaseUnreadReports(db, "The node restarted before the final reply was read");
  let running = true;
  let leases = 1;
  const servers: NodeServer[] = [];
  // Every Pi model runtime this node builds reads credentials from the newest attached connection.
  const credentials = createRemoteCredentialStore(() => servers.at(-1));
  const server = () => {
    const current = servers.at(-1);
    if (!current) throw new Error("Server connection unavailable");
    return current;
  };
  const deliver: NodeOutboxDelivery = (sessionId, item) => {
    if (item.kind === "committed") return server().committed({ sessionId, startSeq: item.startSeq, writesJson: item.payload });
    if (item.kind === "attachment") return server().storeAttachment({ sessionId, ...item.attachment });
    return item.kind === "started" ? server().started({ sessionId, ...JSON.parse(item.payload) }) : server().settled({ sessionId, ...JSON.parse(item.payload) });
  };
  // Delivery failure leaves reports pending for the next drain or attach.
  const drain = (sessionId: string) => { void deliverNodeOutbox(db, sessionId, deliver).catch(() => undefined); };
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
    catch (error) {
      const message = `Attachment fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      // An explicit server rejection is definitive; transport failures may succeed on retry.
      throw error instanceof RpcFailure && error.code === APPLICATION_ERROR ? new AttachmentMaterializationError(message) : new ServerCallFailed(message);
    }
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
  const verify = (id: string, binding: NodeSessionBinding) => {
    const stored = nodeSessionBinding(db, id);
    if (!stored) throw new Error(MISSING_SESSION_MESSAGE);
    if (JSON.stringify(stored) !== JSON.stringify(binding)) throw new Error(`Node session binding mismatch: ${id}`);
    return stored;
  };
  /** Opens from node storage alone: the provisioned task snapshot and Pi's lane (model selection);
   * no server call. `model` validates and seeds a model the caller is about to set (`session.setModel`). */
  const openRuntime = async (sessionId: string, binding: NodeSessionBinding, model?: NodeRuntimePolicy["model"]): Promise<AgentHarnessPiRuntime> => {
    if (!running) throw new Error("Node stopped");
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
        await openNodeStorage(db, sessionId, deliver), policy, db, emitter(sessionId), reporter(sessionId), toolCalls(sessionId));
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
   * main lane already exists, Pi creates it with the provisioned model through its storage adapter;
   * (3) the caller records the admission receipt last. A crash before the receipt leaves no receipt,
   * so the server replays the same command, and each step converges: the binding matches, the lane
   * exists (no second write). A model the node's registry does not know is rejected before step 1,
   * so a rejection leaves nothing behind. Returns a rejection, or null once the session is provisioned.
   */
  const provision = (sessionId: string, binding: NodeSessionBinding, configuration: SessionConfiguration) => serialized(sessionId, async (): Promise<NodeRejection | null> => {
    const selected = configuration.model;
    const models = selected ? await createPiModelRuntime({ credentials }) : undefined;
    const model = selected && models?.getModel(selected.provider, selected.modelId);
    // A replay whose lane already exists has converged even if the model has since become unknown.
    if (selected && !model && !(nodeSessionBinding(db, sessionId) && await storedLaneModel(new PiStorageAdapter(db, sessionId)))) {
      return { code: "invalid_request", message: new NodeModelNotFoundError(selected.provider, selected.modelId).message, retryable: false };
    }
    provisionNodeSession(db, sessionId, binding, configuration.task);
    // No resolved model: no lane; opening fails "requires an explicit model" until session.setModel.
    if (!models || !model) return null;
    const storage = await openNodeStorage(db, sessionId, deliver);
    try {
      if (!await storedLaneModel(storage)) await createMainLane(storage, sessionId, binding, models, model, configuration.thinkingLevel);
      return null;
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  });
  const node: Node = {
    stop(): void {
      if (--leases > 0) return;
      running = false;
      instances.delete(db);
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
    async send(input: NodeCommand, binding: NodeSessionBinding, commandId?: string): Promise<NodeResult> {
      if (!running) throw new Error("Node stopped");
      const payload = JSON.stringify(input);
      const receipt = commandId ? nodeAdmissionReceipt(db, commandId) : null;
      if (receipt && (receipt.sessionId !== input.sessionId || receipt.operation !== input.op || receipt.payload !== payload)) {
        throw new Error(`Node admission receipt mismatch: ${commandId}`);
      }
      if (input.op === "session.provision") {
        if (input.sourceId !== binding.sourceId) throw new Error(`Node source mismatch: ${input.sessionId}`);
        if (!receipt) {
          const rejected = await provision(input.sessionId, binding, input.configuration);
          if (rejected) return { ok: false, error: rejected };
          if (commandId) recordNodeAdmission(db, commandId, input.sessionId, input.op, payload, () => {});
        }
        verify(input.sessionId, binding);
        // Replication unavailability does not invalidate the durable local admission.
        await deliverNodeOutbox(db, input.sessionId, deliver).catch(() => undefined);
        return { ok: true, value: { kind: "provisioned" } };
      }
      if (!nodeSessionBinding(db, input.sessionId)) return { ok: false, error: {
        code: "not_found", message: MISSING_SESSION_MESSAGE, retryable: false,
      } };
      verify(input.sessionId, binding);
      if (receipt) {
        // A positive receipt is safe to query; an absent receipt is NOT proof that Pi did not admit.
        if (input.op === "session.prompt" || input.op === "session.steer") return { ok: true, value: { kind: "admitted", inputId: input.clientId } };
        if (input.op === "session.setModel") return { ok: true, value: { kind: "modelSet" } };
        throw new Error(`Unsupported node admission receipt: ${input.op}`);
      }
      if (input.op === "session.setModel") {
        const model = { provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel ?? null };
        try {
          // Opening validates the new model and seeds a lane Pi has not created yet, so a lane whose
          // stored model is no longer available can still be repaired.
          const runtime = runtimes.get(input.sessionId) ?? await openRuntime(input.sessionId, binding, model);
          await runtime.setModel(model);
        } catch (error) {
          if (error instanceof NodeModelNotFoundError) return { ok: false, error: { code: "invalid_request", message: error.message, retryable: false } };
          throw error;
        }
        // Like prompt/steer, the receipt follows Pi's lane write non-atomically.
        if (commandId) recordNodeAdmission(db, commandId, input.sessionId, input.op, payload, () => {});
        return { ok: true, value: { kind: "modelSet" } };
      }
      if (input.op === "session.prompt" || input.op === "session.steer") {
        try { await materializePromptAttachments(db, input.sessionId, input.content, fetchAttachment); }
        catch (error) {
          if (error instanceof AttachmentMaterializationError) return { ok: false, error: {
            code: "invalid_request", message: error.message, retryable: false,
          } };
          if (error instanceof ServerCallFailed) return { ok: false, error: { code: "unavailable", message: error.message, retryable: true } };
          throw error;
        }
      }
      if (input.op === "session.abort") {
        // Only a live runtime can have a run to abort: never open Pi (or check out a branch) to abort.
        // `aborted` reports whether the runtime was busy when the abort arrived.
        const live = runtimes.get(input.sessionId);
        const busy = live?.isStreaming() ?? false;
        await live?.abort();
        return { ok: true, value: { kind: "aborted", aborted: busy } };
      }
      const ready = await openRuntime(input.sessionId, binding);
      switch (input.op) {
        case "session.prompt":
        case "session.steer": {
          const options = { reinsId: input.clientId, ...(input.sourceSessionId ? { metadata: { sourceSessionId: input.sourceSessionId } } : {}) };
          if (input.op === "session.prompt") await ready.prompt(input.content, options);
          else await ready.steer(input.content, options);
          // Pi admission and this insert are separate transactions. Never infer non-admission
          // from a missing receipt after an interrupted send; server unknown remains fenced.
          if (commandId) recordNodeAdmission(db, commandId, input.sessionId, input.op, payload, () => {});
          return { ok: true, value: { kind: "admitted", inputId: input.clientId } };
        }
        case "session.resumePending":
          if (!ready.resumePendingOperation) throw new Error("Runtime does not support pending-operation resume");
          await ready.resumePendingOperation();
          return { ok: true, value: { kind: "resumed", started: true } };
      }
    },
  };
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
  instances.set(db, {
    node,
    retain: () => { leases++; },
  });
  return node;
}
