import type { z } from "zod";
import { createRpcPeer, RpcFailure, DEFAULT_MAX_FRAME_BYTES, type PeerOptions, type RpcHandler, type WireSocket } from "./peer.js";
import { createLoopbackPair, type LoopbackSocket } from "./loopback.js";
import { APPLICATION_ERROR, nodeError, type NodeError } from "./errors.js";
import { protocolVersion, capability, helloParams, scriptExecuteParams, scriptExecuteResult, scriptCancelParams, scriptSearchParams, scriptSearchResult, projectCreateTaskParams, projectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type ProjectCreateTask, type ProjectCreateTaskResult, provisionParams, provisionResult, readyResult, statusParams, statusResult, methods, sessionCommittedParams, sessionCommittedResult, attachmentFetchParams, attachmentFetchResult, attachmentStoreParams, attachmentStoreResult, imageReference, storedAttachment, type AttachmentStore, type StoredAttachment, provisionConfiguration, type ProvisionConfiguration, sessionEventParams, sessionStartedParams, sessionSettledParams, acknowledgedResult, MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_IMAGE_MIME_TYPES, type AttachmentChunk, type SessionStarted, type SessionSettled, type FinalReply, type SessionEvent, type SessionEventReport, type Capability, type Hello, type Provision, type SessionCommitted, type Ready, type Status, sessionInputParams, sessionInputResult, sessionSetModelParams, sessionSetModelResult, sessionControlParams, sessionAbortResult, sessionResumeResult, promptContent, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT, type SessionInput, type SessionSetModel, type SessionControl } from "./schema.js";

/** Replica and lifecycle apply are idempotent and attachment fetch is read-only, so a timed-out call is safely retried. */
const SERVER_CALL_TIMEOUT_MS = 30_000;
/** Agent tool calls are never retried automatically: execute and createTask may have side effects.
 * Scripts may await several `sessions.wait` calls (each up to 30s), so execute gets a longer bound. */
export const SCRIPT_EXECUTE_TIMEOUT_MS = 5 * 60_000;
export const SCRIPT_SEARCH_TIMEOUT_MS = 30_000;
export const CREATE_TASK_TIMEOUT_MS = 60_000;

/** Session commands the node serves. Each is advertised as a capability by the caller; a command
 * without a handler answers method-not-found. */
export interface NodeCommandHandlers {
  prompt(input: SessionInput): Promise<{ inputId: string }>;
  steer(input: SessionInput): Promise<{ inputId: string }>;
  setModel(input: SessionSetModel): Promise<{ modelSet: true }>;
  abort(input: SessionControl): Promise<{ aborted: boolean }>;
  resumePending(input: SessionControl): Promise<{ started: boolean }>;
}
export interface NodeConnectionOptions extends Hello, PeerOptions, Partial<NodeCommandHandlers> {
  provision(input: Provision): Promise<{ provisioned: true }>;
  status(input: { sessionId: string }): Promise<Status>;
}

/** Test/integration seam: no socket creation, key material, storage, or process lifecycle. */
export function createNodeConnection(socket: WireSocket, options: NodeConnectionOptions) {
  const hello = helloParams.parse({ instanceId: options.instanceId, minVersion: options.minVersion, maxVersion: options.maxVersion, capabilities: options.capabilities });
  let negotiated: Ready | undefined;
  const authorized = (epoch: string, required: Capability) => {
    if (!negotiated || epoch !== negotiated.epoch || !negotiated.capabilities.includes(required)) throw new RpcFailure(-32003, "Stale or unauthorized connection");
  };
  /** A server→node command: the epoch and capability are checked before the handler runs. */
  const command = <P extends z.ZodType<{ epoch: string }>>(method: Capability, params: P, result: z.ZodType, handle: ((input: Omit<z.infer<P>, "epoch">) => Promise<unknown>) | undefined): RpcHandler => ({
    params, result,
    async handle(value) {
      const { epoch, ...input } = params.parse(value);
      authorized(epoch, method);
      if (!handle) throw new RpcFailure(-32601, "Method not found");
      return handle(input);
    },
  });
  const peer = createRpcPeer(socket, {
    [methods.sessionPrompt]: command(methods.sessionPrompt, sessionInputParams, sessionInputResult, options.prompt),
    [methods.sessionSteer]: command(methods.sessionSteer, sessionInputParams, sessionInputResult, options.steer),
    [methods.sessionSetModel]: command(methods.sessionSetModel, sessionSetModelParams, sessionSetModelResult, options.setModel),
    [methods.sessionAbort]: command(methods.sessionAbort, sessionControlParams, sessionAbortResult, options.abort),
    [methods.sessionResumePending]: command(methods.sessionResumePending, sessionControlParams, sessionResumeResult, options.resumePending),
    [methods.sessionProvision]: {
      params: provisionParams, result: provisionResult,
      async handle(value) {
        const input = provisionParams.parse(value);
        authorized(input.epoch, methods.sessionProvision);
        return options.provision({ sessionId: input.sessionId, commandId: input.commandId, binding: input.binding, configuration: input.configuration });
      },
    },
    [methods.sessionStatus]: {
      params: statusParams, result: statusResult,
      async handle(value) {
        const input = statusParams.parse(value);
        authorized(input.epoch, methods.sessionStatus);
        return options.status({ sessionId: input.sessionId });
      },
    },
  }, { maxFrameBytes: options.maxFrameBytes });
  const ready = peer.call(methods.nodeHello, hello, readyResult).then(value => {
    if (value.version < hello.minVersion || value.version > hello.maxVersion || value.capabilities.some(item => !hello.capabilities.includes(item))) {
      peer.close(); throw new RpcFailure(-32001, "Invalid negotiation");
    }
    negotiated = value;
    return value;
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
    async committed(input: SessionCommitted): Promise<void> {
      await peer.call(methods.sessionCommitted, { ...input, epoch: await epoch() }, sessionCommittedResult, { timeoutMs: SERVER_CALL_TIMEOUT_MS });
    },
    async started(input: SessionStarted): Promise<void> {
      await peer.call(methods.sessionStarted, { ...input, epoch: await epoch() }, acknowledgedResult, { timeoutMs: SERVER_CALL_TIMEOUT_MS });
    },
    async settled(input: SessionSettled): Promise<void> {
      await peer.call(methods.sessionSettled, { ...input, epoch: await epoch() }, acknowledgedResult, { timeoutMs: SERVER_CALL_TIMEOUT_MS });
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
        const result = await peer.call(methods.attachmentStore, { ...metadata, epoch: await epoch(), offset, data: chunk }, attachmentStoreResult, { timeoutMs: SERVER_CALL_TIMEOUT_MS });
        if ("stored" in result) return;
        if (result.nextOffset > bytes.byteLength) throw new RpcFailure(APPLICATION_ERROR, `Attachment upload offset out of range: ${input.attachmentId}`);
        offset = result.nextOffset;
      }
      throw new RpcFailure(APPLICATION_ERROR, `Attachment upload did not complete: ${input.attachmentId}`);
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

export { APPLICATION_ERROR, nodeError, createLoopbackPair, createRpcPeer, RpcFailure, capability, helloParams, provisionParams, provisionResult, readyResult, statusParams, statusResult, methods, sessionCommittedParams, sessionCommittedResult, attachmentFetchParams, attachmentFetchResult, attachmentStoreParams, attachmentStoreResult, imageReference, storedAttachment, provisionConfiguration, sessionEventParams, sessionStartedParams, sessionSettledParams, acknowledgedResult, MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_IMAGE_MIME_TYPES, DEFAULT_MAX_FRAME_BYTES, protocolVersion, scriptExecuteParams, scriptExecuteResult, scriptCancelParams, scriptSearchParams, scriptSearchResult, projectCreateTaskParams, projectCreateTaskResult, sessionInputParams, sessionInputResult, sessionSetModelParams, sessionSetModelResult, sessionControlParams, sessionAbortResult, sessionResumeResult, promptContent, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT };
export type { SessionInput, SessionSetModel, SessionControl, NodeError, LoopbackSocket, WireSocket, PeerOptions, Capability, Provision, Ready, Hello, Status, SessionCommitted, AttachmentChunk, AttachmentStore, StoredAttachment, ProvisionConfiguration, SessionEvent, SessionEventReport, SessionStarted, SessionSettled, FinalReply, ScriptExecute, ScriptExecuteResult, ScriptSearch, ScriptSearchResult, ProjectCreateTask, ProjectCreateTaskResult };
