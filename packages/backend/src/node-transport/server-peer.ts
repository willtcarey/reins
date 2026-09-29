import { createHash } from "node:crypto";
import { logger } from "../logger.js";
import { credentialsParams, credentialResult, credentialsListParams, credentialsListResult, type NodeCredential, type CredentialInfo, createRpcPeer, RpcFailure, scriptExecuteParams, scriptExecuteResult, scriptCancelParams, scriptSearchParams, scriptSearchResult, projectCreateTaskParams, projectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type ProjectCreateTask, type ProjectCreateTaskResult, helloParams, readyResult, provisionResult, protocolVersion, nodeError, methods, sessionCommittedParams, sessionCommittedResult, attachmentFetchParams, attachmentFetchResult, attachmentStoreParams, attachmentStoreResult, type StoredAttachment, sessionEventParams, sessionStartedParams, sessionSettledParams, acknowledgedResult, APPLICATION_ERROR, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES, capability, type Capability, type Provision, type SessionInput, type SessionSetModel, type SessionControl, sessionInputResult, sessionSetModelResult, sessionAbortResult, sessionResumeResult, sessionHydrateResult, sessionDeleteResult, type SessionDelete, skillsListResult, type SkillsList, sessionSnapshotParams, sessionSnapshotResult, type SessionHydrate, type SessionSnapshot, type SessionCommitted, type SessionEventReport, type SessionSettled, type SessionStarted, type WireSocket, type LinkOptions, type Ready, systemTimers, storageReadParams, storageReadResult, storageCommitParams, storageCommitResult, type StorageRead, type StorageReadResult, type StorageCommit, type StorageCommitResult } from "@reins/node-protocol";

/** `event` is the node's serialized event, never parsed here. `missed` counts seqs skipped since this
 * connection's previous event for the session (0 for its first). */
export type NodeSessionEvent = SessionEventReport & { missed: number };
export interface ServerAttachment { data: Uint8Array; mimeType: string; byteSize: number; sha256: string; filename?: string; width?: number; height?: number }
/** Server-owned capabilities a node may call. Injected so the transport imports no product stores. */
export interface ServerHandlers {
  committed(input: SessionCommitted): void | Promise<void>;
  /** Durable run lifecycle: acknowledged only after it applied (or was already applied). */
  started(input: SessionStarted): void | Promise<void>;
  settled(input: SessionSettled): void | Promise<void>;
  attachment(sessionId: string, attachmentId: string): ServerAttachment | null | Promise<ServerAttachment | null>;
  /** `attachment.store`: the session's attachment under this ID with its data held (not pruned), or null.
   * Called for every chunk, so it also authorizes the session before any bytes are buffered. */
  findAttachment(sessionId: string, attachmentId: string): StoredAttachment | null | Promise<StoredAttachment | null>;
  /** Stores bytes whose size and sha256 the transport verified under the node-assigned ID; rejects an ID
   * held with different content or by another session. */
  storeAttachment(sessionId: string, attachmentId: string, attachment: ServerAttachment): void | Promise<void>;
  event(input: NodeSessionEvent): void | Promise<void>;
  /** Agent tool calls, scoped by the handler from the server's own row for `sessionId`. `signal`
   * aborts on `script.cancel` for this call or when the connection closes. */
  scriptExecute(input: ScriptExecute, signal: AbortSignal): Promise<ScriptExecuteResult>;
  scriptSearch(input: ScriptSearch): ScriptSearchResult | Promise<ScriptSearchResult>;
  createTask(input: ProjectCreateTask): Promise<ProjectCreateTaskResult>;
  /** Provider credentials for the node's Pi runtimes. The server is the sole holder and sole OAuth
   * refresher: results never carry a refresh token (the strict result schema rejects one). A refresh
   * failure should throw an `RpcFailure` whose data is a `NodeError` with a message free of token material. */
  readCredential(providerId: string): Promise<NodeCredential | null>;
  refreshCredential(providerId: string): Promise<NodeCredential | null>;
  listCredentials(): Promise<CredentialInfo[]>;
  /** `session.snapshot`: one page of the server's copy of a session from `fromSeq`, with its summary.
   * Read-only; the handler authorizes the calling node for the session. */
  snapshot(sessionId: string, fromSeq: number): SessionSnapshot | Promise<SessionSnapshot>;
  /** `storage.read`/`storage.commit`: the session's canonical Pi storage on the server. The handler
   * authorizes the calling node for the session; a commit applies in one transaction, and one Pi refuses
   * should throw an `RpcFailure` whose data is a non-retryable `NodeError`. */
  storageRead(input: StorageRead): Promise<StorageReadResult>;
  storageCommit(input: StorageCommit): Promise<StorageCommitResult>;
}
/** Partial `attachment.store` uploads buffered per connection; the oldest is evicted (and restarts from 0). */
const MAX_PARTIAL_UPLOADS = 8;
const rejection = (error: unknown) => error instanceof RpcFailure ? error : new RpcFailure(APPLICATION_ERROR, error instanceof Error ? error.message : String(error));

/** A negotiated connection: the hello reply and the node ID the node announced. */
export type Negotiated = Ready & { nodeId: string };
/** Resolves the handlers serving a node's calls from the node ID it announced in `node.hello`; throws to
 * refuse the node (the hello is rejected and the connection serves nothing). */
export type ServeNode = (nodeId: string) => ServerHandlers;

/** Server half of one node connection. Local nodes reach it over the permission-protected Unix socket
 * (`local-socket.ts`); a remote node must be enrolled and authenticated before it is exposed to one.
 * `negotiated` resolves once `node.hello` succeeds and rejects if the connection closes (or the hello
 * timeout expires) first. */
export function createServerTransport(socket: WireSocket, serve: ServeNode, options: LinkOptions = {}) {
  let ready: { epoch: string; capabilities: Capability[]; handlers: ServerHandlers } | undefined;
  let settleNegotiation!: { resolve(value: Negotiated): void; reject(reason: Error): void };
  const negotiated = new Promise<Negotiated>((resolve, reject) => { settleNegotiation = { resolve, reject }; });
  negotiated.catch(() => undefined);
  const eventSeqs = new Map<string, number>();
  // In-flight scripts by callId; aborted by `script.cancel` from the same session or on close.
  const scripts = new Map<string, { sessionId: string; controller: AbortController }>();
  // Partial uploads: (sessionId, attachmentId) → the upload's metadata and contiguous prefix received so far.
  const uploads = new Map<string, { byteSize: number; sha256: string; mimeType: string; parts: Buffer[]; received: number }>();
  const peer = createRpcPeer(socket, {
    [methods.nodeHello]: {
      params: helloParams, result: readyResult,
      async handle(value) {
        if (ready) throw new RpcFailure(-32003, "Already negotiated");
        const hello = helloParams.parse(value);
        if (hello.minVersion > protocolVersion || hello.maxVersion < protocolVersion) throw new RpcFailure(-32001, "No common protocol version");
        let handlers: ServerHandlers;
        try { handlers = serve(hello.nodeId); } catch (error) { throw new RpcFailure(-32003, error instanceof Error ? error.message : String(error)); }
        const capabilities = hello.capabilities.filter((item): item is Capability => capability.safeParse(item).success);
        ready = { epoch: crypto.randomUUID(), capabilities, handlers };
        const result = { version: protocolVersion, epoch: ready.epoch, capabilities };
        if (helloTimer !== undefined) timers.clearTimeout(helloTimer);
        settleNegotiation.resolve({ ...result, nodeId: hello.nodeId });
        return result;
      },
    },
    [methods.sessionCommitted]: {
      params: sessionCommittedParams, result: sessionCommittedResult,
      async handle(value) {
        const { epoch, ...input } = sessionCommittedParams.parse(value);
        const handlers = issued(epoch);
        try { await handlers.committed(input); } catch (error) { throw rejection(error); }
        return { acknowledged: true };
      },
    },
    [methods.sessionStarted]: {
      params: sessionStartedParams, result: acknowledgedResult,
      async handle(value) {
        const { epoch, ...input } = sessionStartedParams.parse(value);
        const handlers = issued(epoch);
        try { await handlers.started(input); } catch (error) { throw rejection(error); }
        return { acknowledged: true };
      },
    },
    [methods.sessionSettled]: {
      params: sessionSettledParams, result: acknowledgedResult,
      async handle(value) {
        const { epoch, ...input } = sessionSettledParams.parse(value);
        const handlers = issued(epoch);
        try { await handlers.settled(input); } catch (error) { throw rejection(error); }
        return { acknowledged: true };
      },
    },
    [methods.attachmentFetch]: {
      params: attachmentFetchParams, result: attachmentFetchResult,
      async handle(value) {
        const { epoch, sessionId, attachmentId, offset } = attachmentFetchParams.parse(value);
        const handlers = issued(epoch);
        let attachment;
        try { attachment = await handlers.attachment(sessionId, attachmentId); } catch (error) { throw rejection(error); }
        if (!attachment) return { attachment: null };
        const { data, ...metadata } = attachment;
        if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new RpcFailure(APPLICATION_ERROR, `Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte transfer limit: ${attachmentId}`);
        if (offset > data.byteLength) throw new RpcFailure(APPLICATION_ERROR, `Attachment offset out of range: ${attachmentId}`);
        return { attachment: { ...metadata, data: Buffer.from(data.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES)).toString("base64") } };
      },
    },
    [methods.attachmentStore]: {
      params: attachmentStoreParams, result: attachmentStoreResult,
      async handle(value) {
        const { epoch, sessionId, attachmentId, offset, data, ...metadata } = attachmentStoreParams.parse(value);
        const handlers = issued(epoch);
        const key = JSON.stringify([sessionId, attachmentId]);
        let existing;
        try { existing = await handlers.findAttachment(sessionId, attachmentId); } catch (error) { throw rejection(error); }
        // Already stored under this ID (a replay after a lost reply): no bytes needed. Different content
        // under the same ID is divergence; the node keeps the upload pending.
        if (existing) {
          uploads.delete(key);
          if (existing.sha256 === metadata.sha256 && existing.mimeType === metadata.mimeType && existing.byteSize === metadata.byteSize) return { stored: true };
          throw new RpcFailure(APPLICATION_ERROR, `Attachment ${attachmentId} is already stored with different content`);
        }
        let upload = uploads.get(key);
        if (upload && (upload.byteSize !== metadata.byteSize || upload.sha256 !== metadata.sha256 || upload.mimeType !== metadata.mimeType)) {
          uploads.delete(key);
          throw new RpcFailure(APPLICATION_ERROR, `Attachment upload changed: ${attachmentId}`);
        }
        if (!upload) {
          if (uploads.size >= MAX_PARTIAL_UPLOADS) uploads.delete(uploads.keys().next().value!);
          uploads.set(key, upload = { byteSize: metadata.byteSize, sha256: metadata.sha256, mimeType: metadata.mimeType, parts: [], received: 0 });
        }
        // A retried or out-of-place chunk: the node continues from what this connection holds.
        if (offset !== upload.received) return { nextOffset: upload.received };
        const chunk = Buffer.from(data, "base64");
        if (chunk.byteLength !== Math.min(ATTACHMENT_CHUNK_BYTES, metadata.byteSize - offset)) {
          uploads.delete(key);
          throw new RpcFailure(APPLICATION_ERROR, `Attachment chunk size mismatch: ${attachmentId}`);
        }
        upload.parts.push(chunk);
        upload.received += chunk.byteLength;
        if (upload.received < metadata.byteSize) return { nextOffset: upload.received };
        uploads.delete(key);
        const bytes = Buffer.concat(upload.parts);
        if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new RpcFailure(APPLICATION_ERROR, `Attachment checksum mismatch: ${attachmentId}`);
        try { await handlers.storeAttachment(sessionId, attachmentId, { ...metadata, data: bytes }); } catch (error) { throw rejection(error); }
        return { stored: true };
      },
    },
    [methods.sessionSnapshot]: {
      params: sessionSnapshotParams, result: sessionSnapshotResult,
      async handle(value) {
        const { epoch, sessionId, fromSeq } = sessionSnapshotParams.parse(value);
        const handlers = issued(epoch);
        try { return await handlers.snapshot(sessionId, fromSeq); } catch (error) { throw rejection(error); }
      },
    },
    [methods.storageRead]: {
      params: storageReadParams, result: storageReadResult,
      async handle(value) {
        const { epoch, ...input } = storageReadParams.parse(value);
        const handlers = issued(epoch);
        try { return await handlers.storageRead(input); } catch (error) { throw rejection(error); }
      },
    },
    [methods.storageCommit]: {
      params: storageCommitParams, result: storageCommitResult,
      async handle(value) {
        const { epoch, ...input } = storageCommitParams.parse(value);
        const handlers = issued(epoch);
        try { return await handlers.storageCommit(input); } catch (error) { throw rejection(error); }
      },
    },
    [methods.scriptExecute]: {
      params: scriptExecuteParams, result: scriptExecuteResult,
      async handle(value) {
        const { epoch, callId, ...input } = scriptExecuteParams.parse(value);
        const handlers = issued(epoch);
        if (scripts.has(callId)) throw new RpcFailure(APPLICATION_ERROR, `Duplicate script call: ${callId}`);
        const controller = new AbortController();
        scripts.set(callId, { sessionId: input.sessionId, controller });
        try { return await handlers.scriptExecute(input, controller.signal); } catch (error) { throw rejection(error); }
        finally { scripts.delete(callId); }
      },
    },
    [methods.scriptCancel]: {
      params: scriptCancelParams,
      notify(value) {
        const { epoch, sessionId, callId } = scriptCancelParams.parse(value);
        issued(epoch);
        const script = scripts.get(callId);
        if (script?.sessionId === sessionId) script.controller.abort();
      },
    },
    [methods.scriptSearch]: {
      params: scriptSearchParams, result: scriptSearchResult,
      async handle(value) {
        const { epoch, ...input } = scriptSearchParams.parse(value);
        const handlers = issued(epoch);
        try { return await handlers.scriptSearch(input); } catch (error) { throw rejection(error); }
      },
    },
    [methods.projectCreateTask]: {
      params: projectCreateTaskParams, result: projectCreateTaskResult,
      async handle(value) {
        const { epoch, ...input } = projectCreateTaskParams.parse(value);
        const handlers = issued(epoch);
        try { return await handlers.createTask(input); } catch (error) { throw rejection(error); }
      },
    },
    // Not per session: any negotiated connection (its epoch) is served. A remote node must also be
    // enrolled and authenticated before these are exposed to it.
    [methods.credentialsGet]: {
      params: credentialsParams, result: credentialResult,
      async handle(value) {
        const { epoch, providerId } = credentialsParams.parse(value);
        const handlers = issued(epoch);
        try { return { credential: await handlers.readCredential(providerId) }; } catch (error) { throw rejection(error); }
      },
    },
    [methods.credentialsRefresh]: {
      params: credentialsParams, result: credentialResult,
      async handle(value) {
        const { epoch, providerId } = credentialsParams.parse(value);
        const handlers = issued(epoch);
        try { return { credential: await handlers.refreshCredential(providerId) }; } catch (error) { throw rejection(error); }
      },
    },
    [methods.credentialsList]: {
      params: credentialsListParams, result: credentialsListResult,
      async handle(value) {
        const handlers = issued(credentialsListParams.parse(value).epoch);
        try { return { credentials: await handlers.listCredentials() }; } catch (error) { throw rejection(error); }
      },
    },
    [methods.sessionEvent]: {
      params: sessionEventParams,
      // Only the envelope is validated; the event string is relayed as is. Failures here drop only this
      // notification (logged by the peer).
      notify(value) {
        const { epoch, ...input } = sessionEventParams.parse(value);
        const handlers = issued(epoch);
        const last = eventSeqs.get(input.sessionId);
        if (last !== undefined && input.seq <= last) throw new Error(`Out-of-order session event ${input.sessionId}#${input.seq} after #${last}`);
        eventSeqs.set(input.sessionId, input.seq);
        return handlers.event({ ...input, missed: last === undefined ? 0 : input.seq - last - 1 });
      },
    },
  }, options);
  const timers = options.timers ?? systemTimers;
  const helloTimer = options.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!ready) { logger.warn(`Node did not negotiate within ${options.helloTimeoutMs}ms; closing the connection`); close(); }
  }, options.helloTimeoutMs);
  function close() {
    if (helloTimer !== undefined) timers.clearTimeout(helloTimer);
    settleNegotiation.reject(new RpcFailure("unavailable", "Connection closed before negotiation"));
    for (const { controller } of scripts.values()) controller.abort();
    scripts.clear();
    uploads.clear();
    peer.close();
  }
  // Node→server methods are base protocol: only the epoch this connection issued at hello is accepted.
  // Returns the handlers serving the node this connection negotiated for.
  function issued(epoch: string): ServerHandlers {
    if (!ready || epoch !== ready.epoch) throw new RpcFailure(-32003, "Stale or unauthorized connection");
    return ready.handlers;
  }
  const authorized = (required: Capability) => {
    if (!ready?.capabilities.includes(required)) throw new RpcFailure("unavailable", "Node capability not negotiated");
    return ready.epoch;
  };
  return {
    receive: peer.receive,
    close,
    negotiated,
    // Session commands: a node rejection is -32000 with the NodeResult error as `error.data`.
    async provision(input: Provision, timeoutMs?: number) { return peer.call(methods.sessionProvision, { ...input, epoch: authorized(methods.sessionProvision) }, provisionResult, { errorData: nodeError, timeoutMs }); },
    async prompt(input: SessionInput, timeoutMs?: number) { return peer.call(methods.sessionPrompt, { ...input, epoch: authorized(methods.sessionPrompt) }, sessionInputResult, { errorData: nodeError, timeoutMs }); },
    async steer(input: SessionInput, timeoutMs?: number) { return peer.call(methods.sessionSteer, { ...input, epoch: authorized(methods.sessionSteer) }, sessionInputResult, { errorData: nodeError, timeoutMs }); },
    async setModel(input: SessionSetModel, timeoutMs?: number) { return peer.call(methods.sessionSetModel, { ...input, epoch: authorized(methods.sessionSetModel) }, sessionSetModelResult, { errorData: nodeError, timeoutMs }); },
    async abort(input: SessionControl, timeoutMs?: number) { return peer.call(methods.sessionAbort, { ...input, epoch: authorized(methods.sessionAbort) }, sessionAbortResult, { errorData: nodeError, timeoutMs }); },
    async resumePending(input: SessionControl, timeoutMs?: number) { return peer.call(methods.sessionResumePending, { ...input, epoch: authorized(methods.sessionResumePending) }, sessionResumeResult, { errorData: nodeError, timeoutMs }); },
    async hydrate(input: SessionHydrate, timeoutMs?: number) { return peer.call(methods.sessionHydrate, { ...input, epoch: authorized(methods.sessionHydrate) }, sessionHydrateResult, { errorData: nodeError, timeoutMs }); },
    async delete(input: SessionDelete, timeoutMs?: number) { return peer.call(methods.sessionDelete, { ...input, epoch: authorized(methods.sessionDelete) }, sessionDeleteResult, { errorData: nodeError, timeoutMs }); },
    async listSkills(input: SkillsList, timeoutMs?: number) { return peer.call(methods.skillsList, { ...input, epoch: authorized(methods.skillsList) }, skillsListResult, { errorData: nodeError, timeoutMs }); },
  };
}
