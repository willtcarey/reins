import { createHash } from "node:crypto";
import { logger } from "../logger.js";
import { type NodeCredential, type CredentialInfo, createRpcPeer, RpcFailure, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type ProjectCreateTask, type ProjectCreateTaskResult, helloParams, readyResult, protocolVersion, methods, nodeMethods, serverMethods, serveMethods, methodClient, type MethodInput, type MethodCallOptions, type RequestMethod, type NotificationMethod, type StoredAttachment, APPLICATION_ERROR, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES, capability, type Capability, type SessionEventReport, type SessionSettled, type SessionStarted, type WireSocket, type LinkOptions, type Hello, type Ready, systemTimers, type StorageRead, type StorageReadResult, type StorageCommit, type StorageCommitResult, NEGOTIATION_FAILED, UNAUTHORIZED, NotConnected, authenticateResult, newNodeChallenge, verifyNodeAnswer } from "@reins/node-protocol";
import { createStreamRegistry, type NodeStream } from "./node-streams.js";

/** `event` is the node's serialized event, never parsed here. `missed` counts seqs skipped since this
 * connection's previous event for the session (0 for its first). */
export type NodeSessionEvent = SessionEventReport & { missed: number };
export interface ServerAttachment { data: Uint8Array; mimeType: string; byteSize: number; sha256: string; filename?: string; width?: number; height?: number }
/** Server-owned capabilities a node may call. Injected so the transport imports no product stores. */
export interface ServerHandlers {
  /** Run lifecycle: acknowledged only after it applied (or was already applied). */
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
  /** `storage.read`/`storage.commit`: the session's canonical Pi storage on the server. The handler
   * authorizes the calling node for the session; a commit applies in one transaction, and one Pi refuses
   * should throw an `RpcFailure` whose data is a non-retryable `NodeError`. */
  storageRead(input: StorageRead): Promise<StorageReadResult>;
  storageCommit(input: StorageCommit): Promise<StorageCommitResult>;
}
/** Partial `attachment.store` uploads buffered per connection; the oldest is evicted (and restarts from 0). */
const MAX_PARTIAL_UPLOADS = 8;
const rejection = (error: unknown) => error instanceof RpcFailure ? error : new RpcFailure(APPLICATION_ERROR, error instanceof Error ? error.message : String(error));

/** A negotiated connection: the hello reply, the node ID the node announced and the sessions it said
 * have a run in progress. */
export type Negotiated = Ready & { nodeId: string; liveSessions: string[] };
/** Resolves the handlers serving a node's calls from the node ID it announced in `node.hello`, once per
 * connection; throws to refuse the node (the hello is rejected and the connection serves nothing). */
export type ServeNode = (nodeId: string) => ServerHandlers;

/** How a connection authenticates its node: the origin the node must have signed for (the server origin
 * this transport serves), and the public key a node must prove it holds (base64url of the raw Ed25519 key;
 * null for an unknown, unpaired or revoked node, which is refused). */
export interface Authentication {
  origin: string;
  publicKey(nodeId: string): string | null;
}

export interface ServerTransportOptions extends LinkOptions {
  /** Per-stream buffer cap (`MAX_STREAM_BUFFER_BYTES` by default). */
  maxStreamBufferBytes?: number;
  /** Authenticate the node (`node.authenticate`) before answering its hello. Without it the connection is trusted
   * to be from whichever known node it announces, as on the permission-protected local socket. */
  authenticate?: Authentication;
}

/** Server half of one node connection. Local nodes reach it over the permission-protected Unix socket
 * (`local-socket.ts`) unauthenticated; any other transport passes `authenticate`: the server then
 * challenges the node as soon as the connection is created, closes it when the answer fails, and
 * answers only a hello for the node it authenticated. `negotiated` resolves once `node.hello` succeeds
 * and rejects if the connection closes (or the hello timeout expires) first. */
export function createServerTransport(socket: WireSocket, serve: ServeNode, { maxStreamBufferBytes, authenticate, ...options }: ServerTransportOptions = {}) {
  let ready: { epoch: string; capabilities: Capability[]; handlers: ServerHandlers } | undefined;
  let settleNegotiation!: { resolve(value: Negotiated): void; reject(reason: Error): void };
  const negotiated = new Promise<Negotiated>((resolve, reject) => { settleNegotiation = { resolve, reject }; });
  negotiated.catch(() => undefined);
  const eventSeqs = new Map<string, number>();
  // In-flight scripts by callId; aborted by `script.cancel` from the same session or on close.
  const scripts = new Map<string, { sessionId: string; controller: AbortController }>();
  // Partial uploads: (sessionId, attachmentId) → the upload's metadata and contiguous prefix received so far.
  const uploads = new Map<string, { byteSize: number; sha256: string; mimeType: string; parts: Buffer[]; received: number }>();
  // Streams the server opened on this connection; failed when it closes.
  const streams = createStreamRegistry(streamId => {
    if (ready?.capabilities.includes("stream.cancel")) client.notify("stream.cancel", ready.epoch, { streamId });
  }, { maxBufferedBytes: maxStreamBufferBytes });
  const peer = createRpcPeer(socket, {
    [methods.nodeHello]: {
      params: helloParams, result: readyResult,
      async handle(hello: Hello) {
        if (authenticated) {
          const nodeId = await authenticated.catch(() => { throw new RpcFailure(UNAUTHORIZED, "Not authenticated"); });
          if (hello.nodeId !== nodeId) throw new RpcFailure(UNAUTHORIZED, `Connection authenticated as node ${nodeId}, not ${hello.nodeId}`);
        }
        if (ready) throw new RpcFailure(UNAUTHORIZED, "Already negotiated");
        if (hello.minVersion > protocolVersion || hello.maxVersion < protocolVersion) throw new RpcFailure(NEGOTIATION_FAILED, "No common protocol version");
        let handlers: ServerHandlers;
        try { handlers = serve(hello.nodeId); } catch (error) { throw new RpcFailure(UNAUTHORIZED, error instanceof Error ? error.message : String(error)); }
        const capabilities = hello.capabilities.filter((item): item is Capability => capability.safeParse(item).success);
        ready = { epoch: crypto.randomUUID(), capabilities, handlers };
        const result = { version: protocolVersion, epoch: ready.epoch, capabilities };
        if (helloTimer !== undefined) timers.clearTimeout(helloTimer);
        settleNegotiation.resolve({ ...result, nodeId: hello.nodeId, liveSessions: hello.liveSessions });
        return result;
      },
    },
    // Node→server methods, served for the epoch `issued` accepts; product handler failures are sent as
    // application errors (`rejection`).
    ...serveMethods(serverMethods, {
      "session.started": async (input, server) => { await server.started(input); return { acknowledged: true }; },
      "session.settled": async (input, server) => { await server.settled(input); return { acknowledged: true }; },
      async "attachment.fetch"({ sessionId, attachmentId, offset }, server) {
        const attachment = await server.attachment(sessionId, attachmentId);
        if (!attachment) return { attachment: null };
        const { data, ...metadata } = attachment;
        if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new RpcFailure(APPLICATION_ERROR, `Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte transfer limit: ${attachmentId}`);
        if (offset > data.byteLength) throw new RpcFailure(APPLICATION_ERROR, `Attachment offset out of range: ${attachmentId}`);
        return { attachment: { ...metadata, data: Buffer.from(data.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES)).toString("base64") } };
      },
      async "attachment.store"({ sessionId, attachmentId, offset, data, ...metadata }, server) {
        const key = JSON.stringify([sessionId, attachmentId]);
        const existing = await server.findAttachment(sessionId, attachmentId);
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
        await server.storeAttachment(sessionId, attachmentId, { ...metadata, data: bytes });
        return { stored: true };
      },
      "storage.read": (input, server) => server.storageRead(input),
      "storage.commit": (input, server) => server.storageCommit(input),
      async "script.execute"({ callId, ...input }, server) {
        if (scripts.has(callId)) throw new RpcFailure(APPLICATION_ERROR, `Duplicate script call: ${callId}`);
        const controller = new AbortController();
        scripts.set(callId, { sessionId: input.sessionId, controller });
        try { return await server.scriptExecute(input, controller.signal); } finally { scripts.delete(callId); }
      },
      "script.cancel": ({ sessionId, callId }) => {
        const script = scripts.get(callId);
        if (script?.sessionId === sessionId) script.controller.abort();
      },
      "script.search": (input, server) => server.scriptSearch(input),
      "project.createTask": (input, server) => server.createTask(input),
      // Not per session: any negotiated connection (its epoch) is served, so a transport other than the
      // permission-protected local socket must authenticate its connections (`authenticate`).
      "credentials.get": async ({ providerId }, server) => ({ credential: await server.readCredential(providerId) }),
      "credentials.refresh": async ({ providerId }, server) => ({ credential: await server.refreshCredential(providerId) }),
      "credentials.list": async (_, server) => ({ credentials: await server.listCredentials() }),
      // Only the envelope is validated; the event string is relayed as is. Failures here drop only this
      // notification (logged by the peer).
      "session.event": (input, server) => {
        const last = eventSeqs.get(input.sessionId);
        if (last !== undefined && input.seq <= last) throw new Error(`Out-of-order session event ${input.sessionId}#${input.seq} after #${last}`);
        eventSeqs.set(input.sessionId, input.seq);
        return server.event({ ...input, missed: last === undefined ? 0 : input.seq - last - 1 });
      },
      // In stream order; a bad chunk fails its stream only.
      "stream.data": input => streams.data(input),
      "stream.end": input => streams.end(input),
    }, issued, rejection),
  }, options);
  const client = methodClient(peer, nodeMethods);
  const timers = options.timers ?? systemTimers;
  const helloTimer = options.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!ready) { logger.warn(`Node did not negotiate within ${options.helloTimeoutMs}ms; closing the connection`); close(); }
  }, options.helloTimeoutMs);
  let closed = false;
  // Server first: one challenge per connection, consumed by the first answer whatever its outcome (the
  // peer accepts one reply per call). Resolves with the node ID the answer proved.
  const authenticated = authenticate && authenticateNode(authenticate);
  async function authenticateNode({ origin, publicKey }: Authentication): Promise<string> {
    const challenge = newNodeChallenge();
    let nodeId: string | undefined;
    try {
      const answer = await peer.call(methods.nodeAuthenticate, challenge, authenticateResult);
      nodeId = answer.nodeId;
      const key = publicKey(answer.nodeId);
      if (!key) throw new Error("not a paired node (unknown, unpaired or revoked)");
      if (!verifyNodeAnswer({ publicKey: key, origin, challenge, answer })) throw new Error("invalid signature");
      return answer.nodeId;
    } catch (error) {
      // Never log the challenge or the answer: only who claimed what, and why it failed.
      if (!closed && !(error instanceof NotConnected)) logger.warn(`Node authentication failed${nodeId === undefined ? "" : ` for node ${nodeId}`}: ${error instanceof Error ? error.message : String(error)}; closing the connection`);
      close();
      throw error;
    }
  }
  authenticated?.catch(() => undefined);
  function close() {
    closed = true;
    if (helloTimer !== undefined) timers.clearTimeout(helloTimer);
    settleNegotiation.reject(new RpcFailure("unavailable", "Connection closed before negotiation"));
    for (const { controller } of scripts.values()) controller.abort();
    scripts.clear();
    uploads.clear();
    streams.close();
    peer.close();
  }
  // Node→server methods are base protocol: only the epoch this connection issued at hello is accepted.
  // Returns the handlers serving the node this connection negotiated for.
  function issued(epoch: string): ServerHandlers {
    if (!ready || epoch !== ready.epoch) throw new RpcFailure(UNAUTHORIZED, "Stale or unauthorized connection");
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
    /** Server→node calls, once their capability is negotiated. A node rejection is `APPLICATION_ERROR` with
     * the `NodeError` as `error.data`. */
    async call<M extends RequestMethod<typeof nodeMethods>>(method: M, input: MethodInput<(typeof nodeMethods)[M]>, call?: MethodCallOptions) { return client.call(method, authorized(method), input, call); },
    /** Server→node notifications, best effort: false when the capability was not negotiated or the frame
     * could not be sent. */
    notify<M extends NotificationMethod<typeof nodeMethods>>(method: M, input: MethodInput<(typeof nodeMethods)[M]>): boolean {
      return !!ready?.capabilities.includes(method) && client.notify(method, ready.epoch, input);
    },
    /** Opens a stream from the node (see `createStreamRegistry`): `start` sends the opening request with
     * the `streamId` allocated for it. Only a node that negotiated `stream.cancel` serves streams. */
    async openStream<T>(start: (streamId: string) => Promise<T>): Promise<NodeStream<T>> {
      authorized("stream.cancel");
      return streams.open(start);
    },
  };
}
