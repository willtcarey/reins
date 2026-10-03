/** The node end of a connection, and what negotiating one takes: the protocol version, the `node.hello`
 * exchange and the full list of method names. (These live here rather than in `method-table.ts`, which
 * knows no concrete method: `methods` needs both tables, and the tables load `method-table.ts`.) */
import { z } from "zod";
import { createRpcPeer, HEARTBEAT_METHOD, NEGOTIATION_FAILED, NotConnected, RpcFailure, systemTimers, UNAUTHORIZED, type WireSocket } from "./rpc.js";
import type { LinkOptions } from "./local-socket.js";
import { APPLICATION_ERROR } from "./errors.js";
import { ATTACHMENT_CHUNK_BYTES, id } from "./fields.js";
import { methodClient, methodKeys, serveMethods } from "./method-table.js";
import { capability, nodeMethods, type Capability, type SessionClose, type SessionControl, type SessionInput, type SessionResume, type SessionSetModel, type SkillsList, type SkillsListResult } from "./node-methods.js";
import { createStreamSender, type OpenStreamSource } from "./streams.js";
import { serverMethods, type AttachmentChunk, type AttachmentStore, type CredentialInfo, type NodeCredential, type ProjectCreateTask, type ProjectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type SessionEventReport, type SessionSettled, type SessionStarted, type StorageCommit, type StorageCommitResult, type StorageRead, type StorageReadResult } from "./server-methods.js";

/** Wire protocol version, negotiated in `node.hello`; independent of how the server stores commands. */
export const protocolVersion = 5 as const;
/** Every wire method name, keyed `scopeName`. Named for what is happening, not which side serves it:
 * commands are imperatives, requests name the resource, reports are past tense; `node.` is
 * connection-level (`node.hello` negotiates the epoch the tables' methods carry, so it is in neither). */
export const methods = { nodeHello: "node.hello", nodePing: HEARTBEAT_METHOD, ...methodKeys(nodeMethods), ...methodKeys(serverMethods) } as const;
/** Upper bound on `node.hello`'s `liveSessions`. */
export const MAX_LIVE_SESSIONS = 4096;
export const helloParams = z.strictObject({
  minVersion: z.number().int().positive(), maxVersion: z.number().int().positive(),
  capabilities: z.array(id).max(16),
  /** The connecting node's ID: the server serves the connection only for a node it knows (a `nodes` row). */
  nodeId: id,
  /** Sessions with an open runtime on the node when it dialed. After negotiation the server settles every
   * session on this node it still sees running and that is not listed as interrupted (crash recovery). */
  liveSessions: z.array(id).max(MAX_LIVE_SESSIONS),
}).refine(value => value.minVersion <= value.maxVersion);
export const readyResult = z.strictObject({
  version: z.literal(protocolVersion), capabilities: z.array(capability).max(16), epoch: z.string().uuid(),
});
export type Hello = z.infer<typeof helloParams>;
export type Ready = z.infer<typeof readyResult>;

/** Session commands the node serves, one handler per wire method (the node advertises each as a
 * capability). A handler rejects with an `RpcFailure` (e.g. `APPLICATION_ERROR` whose data is a
 * `NodeError`). */
export interface NodeCommandHandlers {
  prompt(input: SessionInput): Promise<{ inputId: string }>;
  steer(input: SessionInput): Promise<{ inputId: string }>;
  setModel(input: SessionSetModel): Promise<{ modelSet: true }>;
  abort(input: SessionControl): Promise<{ aborted: boolean }>;
  resumePending(input: SessionResume): Promise<{ started: boolean }>;
  close(input: SessionClose): Promise<{ closed: boolean }>;
  /** `skills.list`: read-only, not a session command. */
  listSkills(input: SkillsList): Promise<SkillsListResult>;
}
export interface NodeConnectionOptions extends Hello, LinkOptions, NodeCommandHandlers {}

/** The node side of one negotiated connection over `socket`: serves `options`' session commands and
 * returns the server calls. Owns no socket creation, storage or process lifecycle (see `connectNode`). */
export function createNodeConnection(socket: WireSocket, options: NodeConnectionOptions) {
  const hello = helloParams.parse({ nodeId: options.nodeId, minVersion: options.minVersion, maxVersion: options.maxVersion, capabilities: options.capabilities, liveSessions: options.liveSessions });
  let negotiated: Ready | undefined;
  /** The server sends commands as soon as it has answered hello (a reconnect replays queued work at
   * once), so a command can arrive in the same read as the reply, before this side has processed it:
   * wait for negotiation to settle before checking the epoch. */
  const authorized = async (epoch: string, required: Capability) => {
    await ready.catch(() => undefined);
    if (!negotiated || epoch !== negotiated.epoch || !negotiated.capabilities.includes(required)) throw new RpcFailure(UNAUTHORIZED, "Stale or unauthorized connection");
  };
  // Server→node commands: the epoch and capability are checked before the handler runs.
  const peer = createRpcPeer(socket, serveMethods(nodeMethods, {
    "session.prompt": options.prompt, "session.steer": options.steer, "session.setModel": options.setModel, "session.abort": options.abort,
    "session.resumePending": options.resumePending, "session.close": options.close, "skills.list": options.listSkills,
    "stream.cancel": ({ streamId }) => streams.cancel(streamId),
  }, authorized), { maxFrameBytes: options.maxFrameBytes, heartbeat: options.heartbeat, timers: options.timers });
  const server = methodClient(peer, serverMethods);
  // Streams belong to this connection: chunks carry its epoch and stop when it closes.
  const streams = createStreamSender({
    data: input => !!negotiated && server.notify("stream.data", negotiated.epoch, input),
    end: input => !!negotiated && server.notify("stream.end", negotiated.epoch, input),
    drained: () => peer.drained(),
  });
  // Negotiation bound: closing fails the pending hello, so `ready` rejects.
  const timers = options.timers ?? systemTimers;
  const helloTimer = options.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!negotiated) { console.warn(`Node negotiation timed out after ${options.helloTimeoutMs}ms; closing the connection`); peer.close(); }
  }, options.helloTimeoutMs);
  const ready = peer.call(methods.nodeHello, hello, readyResult).finally(() => { if (helloTimer !== undefined) timers.clearTimeout(helloTimer); }).then(value => {
    if (value.version < hello.minVersion || value.version > hello.maxVersion || value.capabilities.some(item => !hello.capabilities.includes(item))) {
      peer.close(); throw new RpcFailure(NEGOTIATION_FAILED, "Invalid negotiation");
    }
    negotiated = value;
    return value;
  }).catch((error: unknown) => {
    // A connection that failed to negotiate (rejected, timed out, closed) serves nothing: close it.
    peer.close();
    throw error;
  });
  /** A server call waits for negotiation; one made on a connection that fails to negotiate was never sent. */
  const epoch = async () => {
    try { return (await ready).epoch; }
    catch (error) { throw new NotConnected(`Connection not negotiated: ${error instanceof Error ? error.message : String(error)}`); }
  };
  return {
    receive: peer.receive, ready,
    close() { streams.close(); peer.close(); },
    /** Serves a stream the server opened on this connection (see `streams.ts`): call it from the opening
     * request's handler with the request's `streamId`. Resolves once the stream is over; throws when that
     * stream is already open. */
    stream(streamId: string, source: OpenStreamSource): Promise<void> { return streams.serve(streamId, source); },
    /** Best effort and ordered: waits for negotiation, then notifies; dropped if negotiation fails or the frame is unsendable. */
    event(input: SessionEventReport): void {
      void ready.then(value => {
        if (!server.notify("session.event", value.epoch, input)) console.warn(`Dropped session event ${input.sessionId}#${input.seq}`);
      }, () => undefined);
    },
    /** Lifecycle reports and uploads: a server rejection may carry a `NodeError` as `data` (`not_owner` when
     * the session's source is not on this node). */
    async started(input: SessionStarted): Promise<void> { await server.call("session.started", await epoch(), input); },
    async settled(input: SessionSettled): Promise<void> { await server.call("session.settled", await epoch(), input); },
    /** On abort or timeout (outcome unknown) also sends a best-effort `script.cancel`, which aborts
     * the script's signal on the server. */
    async executeScript(input: ScriptExecute, signal?: AbortSignal): Promise<ScriptExecuteResult> {
      const current = await epoch();
      const callId = crypto.randomUUID();
      try {
        return await server.call("script.execute", current, { ...input, callId }, { signal });
      } catch (error) {
        if (error instanceof RpcFailure && error.outcome === "unknown") server.notify("script.cancel", current, { sessionId: input.sessionId, callId });
        throw error;
      }
    },
    async searchScript(input: ScriptSearch, signal?: AbortSignal): Promise<ScriptSearchResult> { return server.call("script.search", await epoch(), input, { signal }); },
    async createTask(input: ProjectCreateTask, signal?: AbortSignal): Promise<ProjectCreateTaskResult> { return server.call("project.createTask", await epoch(), input, { signal }); },
    /** Credentials the server holds; a rejection carries a `NodeError` as `data`. */
    async getCredential(providerId: string, signal?: AbortSignal): Promise<NodeCredential | null> {
      return (await server.call("credentials.get", await epoch(), { providerId }, { signal })).credential;
    },
    /** The server refreshes the login (at most once, under its own serialization) and returns the current credential. */
    async refreshCredential(providerId: string, signal?: AbortSignal): Promise<NodeCredential | null> {
      return (await server.call("credentials.refresh", await epoch(), { providerId }, { signal })).credential;
    },
    async listCredentials(signal?: AbortSignal): Promise<CredentialInfo[]> {
      return (await server.call("credentials.list", await epoch(), {}, { signal })).credentials;
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
        const result = await server.call("attachment.store", await epoch(), { ...metadata, offset, data: chunk });
        if ("stored" in result) return;
        if (result.nextOffset > bytes.byteLength) throw new RpcFailure(APPLICATION_ERROR, `Attachment upload offset out of range: ${input.attachmentId}`);
        offset = result.nextOffset;
      }
      throw new RpcFailure(APPLICATION_ERROR, `Attachment upload did not complete: ${input.attachmentId}`);
    },
    /** Session storage on the server (`storage.read`, `storage.commit`). A refusal is an application error
     * whose data is a `NodeError` (`invalid_request` for a commit or read Pi refused, `not_owner` for a
     * commit to a session this node does not own); a commit that times out or loses its link has an
     * unknown outcome and is not retried. */
    async readStorage(input: StorageRead): Promise<StorageReadResult> { return server.call("storage.read", await epoch(), input); },
    async commitStorage(input: StorageCommit): Promise<StorageCommitResult> { return server.call("storage.commit", await epoch(), input); },
    /** Assembles chunks; the caller verifies size and sha256 of the whole attachment. */
    async fetchAttachment(sessionId: string, attachmentId: string): Promise<(Omit<AttachmentChunk, "data"> & { data: Uint8Array }) | null> {
      const parts: Buffer[] = [];
      let first: AttachmentChunk | undefined;
      for (let offset = 0; ;) {
        const { attachment } = await server.call("attachment.fetch", await epoch(), { sessionId, attachmentId, offset });
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
