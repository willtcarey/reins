import type { z } from "zod";
import { createRpcPeer, RpcFailure, systemTimers, type RpcHandler, type WireSocket } from "./peer.js";
import type { LinkOptions } from "./local-link.js";
import { APPLICATION_ERROR, nodeError } from "./errors.js";
import { credentialResult, credentialsListResult, type NodeCredential, type CredentialInfo, helloParams, scriptExecuteResult, scriptSearchResult, projectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type ProjectCreateTask, type ProjectCreateTaskResult, provisionParams, provisionResult, readyResult, methods, sessionCommittedResult, attachmentFetchResult, attachmentStoreResult, type AttachmentStore, sessionInputParams, sessionInputResult, sessionSetModelParams, sessionSetModelResult, sessionControlParams, sessionAbortResult, sessionResumeResult, acknowledgedResult, ATTACHMENT_CHUNK_BYTES, type AttachmentChunk, type SessionStarted, type SessionSettled, type SessionEventReport, type Capability, type Hello, type Provision, type SessionCommitted, type Ready, type SessionInput, type SessionSetModel, type SessionControl, sessionHydrateParams, sessionHydrateResult, sessionSnapshotResult, type SessionHydrate, type SessionSnapshot, sessionDeleteParams, sessionDeleteResult, type SessionDelete } from "./schema.js";

/** Replica and lifecycle apply are idempotent and attachment fetch is read-only, so a timed-out call is safely retried. */
const SERVER_CALL_TIMEOUT_MS = 30_000;
/** Agent tool calls are never retried automatically: execute and createTask may have side effects.
 * Scripts may await several `sessions.wait` calls (each up to 30s), so execute gets a longer bound. */
const SCRIPT_EXECUTE_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_SEARCH_TIMEOUT_MS = 30_000;
const CREATE_TASK_TIMEOUT_MS = 60_000;
/** A refresh may wait behind another refresh of the same login on the server, then call the provider
 * (Pi bounds each provider refresh at 15s). */
const CREDENTIAL_REFRESH_TIMEOUT_MS = 60_000;

/** Session commands the node serves, one handler per wire method (the node advertises each as a
 * capability). A handler rejects with an `RpcFailure` (e.g. `APPLICATION_ERROR` whose data is a
 * `NodeError`). */
export interface NodeCommandHandlers {
  provision(input: Provision): Promise<{ provisioned: true }>;
  prompt(input: SessionInput): Promise<{ inputId: string }>;
  steer(input: SessionInput): Promise<{ inputId: string }>;
  setModel(input: SessionSetModel): Promise<{ modelSet: true }>;
  abort(input: SessionControl): Promise<{ aborted: boolean }>;
  resumePending(input: SessionControl): Promise<{ started: boolean }>;
  hydrate(input: SessionHydrate): Promise<{ hydrated: true }>;
  delete(input: SessionDelete): Promise<{ deleted: true }>;
}
export interface NodeConnectionOptions extends Hello, LinkOptions, NodeCommandHandlers {}

/** The node side of one negotiated connection over `socket`: serves `options`' session commands and
 * returns the server calls. Owns no socket creation, storage or process lifecycle (see `connectNode`). */
export function createNodeConnection(socket: WireSocket, options: NodeConnectionOptions) {
  const hello = helloParams.parse({ nodeId: options.nodeId, minVersion: options.minVersion, maxVersion: options.maxVersion, capabilities: options.capabilities });
  let negotiated: Ready | undefined;
  /** The server sends commands as soon as it has answered hello (a reconnect replays queued work at
   * once), so a command can arrive in the same read as the reply, before this side has processed it:
   * wait for negotiation to settle before checking the epoch. */
  const authorized = async (epoch: string, required: Capability) => {
    await ready.catch(() => undefined);
    if (!negotiated || epoch !== negotiated.epoch || !negotiated.capabilities.includes(required)) throw new RpcFailure(-32003, "Stale or unauthorized connection");
  };
  /** A server→node command: the epoch and capability are checked before the handler runs. */
  const command = <P extends z.ZodType<{ epoch: string }>>(method: Capability, params: P, result: z.ZodType, handle: (input: Omit<z.infer<P>, "epoch">) => Promise<unknown>): RpcHandler => ({
    params, result,
    async handle(value) {
      const { epoch, ...input } = params.parse(value);
      await authorized(epoch, method);
      return handle(input);
    },
  });
  const peer = createRpcPeer(socket, {
    [methods.sessionProvision]: command(methods.sessionProvision, provisionParams, provisionResult, options.provision),
    [methods.sessionPrompt]: command(methods.sessionPrompt, sessionInputParams, sessionInputResult, options.prompt),
    [methods.sessionSteer]: command(methods.sessionSteer, sessionInputParams, sessionInputResult, options.steer),
    [methods.sessionSetModel]: command(methods.sessionSetModel, sessionSetModelParams, sessionSetModelResult, options.setModel),
    [methods.sessionAbort]: command(methods.sessionAbort, sessionControlParams, sessionAbortResult, options.abort),
    [methods.sessionResumePending]: command(methods.sessionResumePending, sessionControlParams, sessionResumeResult, options.resumePending),
    [methods.sessionHydrate]: command(methods.sessionHydrate, sessionHydrateParams, sessionHydrateResult, options.hydrate),
    [methods.sessionDelete]: command(methods.sessionDelete, sessionDeleteParams, sessionDeleteResult, options.delete),
  }, { maxFrameBytes: options.maxFrameBytes, heartbeat: options.heartbeat, timers: options.timers });
  // Negotiation bound: closing fails the pending hello, so `ready` rejects.
  const timers = options.timers ?? systemTimers;
  const helloTimer = options.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!negotiated) { console.warn(`Node negotiation timed out after ${options.helloTimeoutMs}ms; closing the connection`); peer.close(); }
  }, options.helloTimeoutMs);
  const ready = peer.call(methods.nodeHello, hello, readyResult).finally(() => { if (helloTimer !== undefined) timers.clearTimeout(helloTimer); }).then(value => {
    if (value.version < hello.minVersion || value.version > hello.maxVersion || value.capabilities.some(item => !hello.capabilities.includes(item))) {
      peer.close(); throw new RpcFailure(-32001, "Invalid negotiation");
    }
    negotiated = value;
    return value;
  }).catch((error: unknown) => {
    // A connection that failed to negotiate (rejected, timed out, closed) serves nothing: close it.
    peer.close();
    throw error;
  });
  const epoch = async () => (await ready).epoch;
  return {
    receive: peer.receive, close: peer.close, ready,
    /** Best effort and ordered: waits for negotiation, then notifies; dropped if negotiation fails or the frame is unsendable. */
    event(input: SessionEventReport): void {
      void ready.then(value => {
        if (!peer.notify(methods.sessionEvent, { ...input, epoch: value.epoch })) console.warn(`Dropped session event ${input.sessionId}#${input.seq}`);
      }, () => undefined);
    },
    /** Durable reports and uploads: a server rejection may carry a `NodeError` as `data` (`not_owner` when
     * this node no longer owns the session). */
    async committed(input: SessionCommitted): Promise<void> {
      await peer.call(methods.sessionCommitted, { ...input, epoch: await epoch() }, sessionCommittedResult, { errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS });
    },
    async started(input: SessionStarted): Promise<void> {
      await peer.call(methods.sessionStarted, { ...input, epoch: await epoch() }, acknowledgedResult, { errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS });
    },
    async settled(input: SessionSettled): Promise<void> {
      await peer.call(methods.sessionSettled, { ...input, epoch: await epoch() }, acknowledgedResult, { errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS });
    },
    /** On abort or timeout (outcome unknown) also sends a best-effort `script.cancel`, which aborts
     * the script's signal on the server. */
    async executeScript(input: ScriptExecute, signal?: AbortSignal): Promise<ScriptExecuteResult> {
      const current = await epoch();
      const callId = crypto.randomUUID();
      try {
        return await peer.call(methods.scriptExecute, { ...input, callId, epoch: current }, scriptExecuteResult, { timeoutMs: SCRIPT_EXECUTE_TIMEOUT_MS, signal });
      } catch (error) {
        if (error instanceof RpcFailure && error.outcome === "unknown") peer.notify(methods.scriptCancel, { epoch: current, sessionId: input.sessionId, callId });
        throw error;
      }
    },
    async searchScript(input: ScriptSearch, signal?: AbortSignal): Promise<ScriptSearchResult> {
      return peer.call(methods.scriptSearch, { ...input, epoch: await epoch() }, scriptSearchResult, { timeoutMs: SCRIPT_SEARCH_TIMEOUT_MS, signal });
    },
    async createTask(input: ProjectCreateTask, signal?: AbortSignal): Promise<ProjectCreateTaskResult> {
      return peer.call(methods.projectCreateTask, { ...input, epoch: await epoch() }, projectCreateTaskResult, { timeoutMs: CREATE_TASK_TIMEOUT_MS, signal });
    },
    /** Credentials the server holds; a rejection carries a `NodeError` as `data`. */
    async getCredential(providerId: string, signal?: AbortSignal): Promise<NodeCredential | null> {
      return (await peer.call(methods.credentialsGet, { epoch: await epoch(), providerId }, credentialResult, { errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS, signal })).credential;
    },
    /** The server refreshes the login (at most once, under its own serialization) and returns the current credential. */
    async refreshCredential(providerId: string, signal?: AbortSignal): Promise<NodeCredential | null> {
      return (await peer.call(methods.credentialsRefresh, { epoch: await epoch(), providerId }, credentialResult, { errorData: nodeError, timeoutMs: CREDENTIAL_REFRESH_TIMEOUT_MS, signal })).credential;
    },
    async listCredentials(signal?: AbortSignal): Promise<CredentialInfo[]> {
      return (await peer.call(methods.credentialsList, { epoch: await epoch() }, credentialsListResult, { errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS, signal })).credentials;
    },
    /** Uploads node-created bytes under the node-assigned ID in chunks, continuing from the server's
     * `nextOffset` (a retried or evicted partial upload resumes or restarts). Each chunk call has its own
     * timeout; a failure leaves the outcome unknown, which is safe to retry because the server answers a
     * repeated ID with the same content as stored. */
    async storeAttachment(input: AttachmentStore & { data: Uint8Array }): Promise<void> {
      const { data, ...metadata } = input;
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      // Every chunk at most twice (one restart after an evicted partial) plus the answer.
      const limit = 2 * Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_BYTES) + 2;
      for (let offset = 0, calls = 0; calls < limit; calls++) {
        const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES).toString("base64");
        const result = await peer.call(methods.attachmentStore, { ...metadata, epoch: await epoch(), offset, data: chunk }, attachmentStoreResult, { errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS });
        if ("stored" in result) return;
        if (result.nextOffset > bytes.byteLength) throw new RpcFailure(APPLICATION_ERROR, `Attachment upload offset out of range: ${input.attachmentId}`);
        offset = result.nextOffset;
      }
      throw new RpcFailure(APPLICATION_ERROR, `Attachment upload did not complete: ${input.attachmentId}`);
    },
    /** One page of the server's copy of a session (see `session.snapshot`); read-only, so safe to retry. */
    async snapshot(sessionId: string, fromSeq: number): Promise<SessionSnapshot> {
      return peer.call(methods.sessionSnapshot, { epoch: await epoch(), sessionId, fromSeq }, sessionSnapshotResult, { timeoutMs: SERVER_CALL_TIMEOUT_MS });
    },
    /** Assembles chunks; the caller verifies size and sha256 of the whole attachment. */
    async fetchAttachment(sessionId: string, attachmentId: string): Promise<(Omit<AttachmentChunk, "data"> & { data: Uint8Array }) | null> {
      const parts: Buffer[] = [];
      let first: AttachmentChunk | undefined;
      for (let offset = 0; ;) {
        const { attachment } = await peer.call(methods.attachmentFetch, { epoch: await epoch(), sessionId, attachmentId, offset }, attachmentFetchResult, { timeoutMs: SERVER_CALL_TIMEOUT_MS });
        if (!attachment) { if (first) throw new RpcFailure(APPLICATION_ERROR, `Attachment changed during fetch: ${attachmentId}`); return null; }
        first ??= attachment;
        if (attachment.byteSize !== first.byteSize || attachment.sha256 !== first.sha256 || attachment.mimeType !== first.mimeType) throw new RpcFailure(APPLICATION_ERROR, `Attachment changed during fetch: ${attachmentId}`);
        const chunk = Buffer.from(attachment.data, "base64");
        if (chunk.byteLength !== Math.min(ATTACHMENT_CHUNK_BYTES, first.byteSize - offset)) throw new RpcFailure(APPLICATION_ERROR, `Attachment chunk size mismatch: ${attachmentId}`);
        parts.push(chunk);
        offset += chunk.byteLength;
        if (offset >= first.byteSize) return { ...first, data: new Uint8Array(Buffer.concat(parts)) };
      }
    },
  };
}

