/** The node end of a connection, and what negotiating one takes: the protocol version, the `node.hello`
 * exchange and the full list of method names. (These live here rather than in `method-table.ts`, which
 * knows no concrete method: `methods` needs both tables, and the tables load `method-table.ts`.) */
import { z } from "zod";
import { createRpcPeer, HEARTBEAT_METHOD, INTERNAL_ERROR, MAX_ERROR_MESSAGE, NEGOTIATION_FAILED, NODE_REFUSED, NotConnected, RpcFailure, systemTimers, UNAUTHORIZED, type RpcHandlers, type WireSocket } from "./rpc.js";
import type { LinkOptions } from "./local-socket.js";
import { APPLICATION_ERROR } from "./errors.js";
import { ATTACHMENT_CHUNK_BYTES, id, sha256 } from "./fields.js";
import { methodClient, methodKeys, serveMethods } from "./method-table.js";
import { capability, nodeMethods, type Capability, type CredentialsChanged, type FsList, type FsListResult, type FsRead, type FsReadResult, type FsWrite, type FsWriteResult, type NodeReload, type ProcessRun, type SessionClose, type SessionAbort, type SessionInput, type SessionResume, type SessionSetModel, type SkillsList, type SkillsListResult } from "./node-methods.js";
import { createStreamSender, type OpenStreamSource } from "./streams.js";
import { authenticateParams, authenticateResult, signNodeChallenge, type NodeChallenge, type NodeIdentity } from "./node-auth.js";
import { serverMethods, storageChunkChars, storageCommitResult, storageReadResult, type HeldStorageReply, type AttachmentChunk, type AttachmentStore, type CredentialInfo, type NodeCredential, type ProjectCreateTask, type ProjectCreateTaskResult, type ScriptExecute, type ScriptExecuteResult, type ScriptSearch, type ScriptSearchResult, type SessionEventReport, type SessionSettled, type SessionStarted, type StorageCommit, type StorageCommitResult, type StorageRead, type StorageReadResult } from "./server-methods.js";

/** Wire protocol version, negotiated in `node.hello`; independent of how the server stores commands. The
 * hello's envelope and its reply kinds are not versioned by it: they are bootstrap surface (`helloParams`,
 * `helloResult`), read by nodes and servers of other releases, and change only additively. */
export const protocolVersion = 10 as const;
/** Every wire method name, keyed `scopeName`. Named for what is happening, not which side serves it:
 * commands are imperatives, requests name the resource, reports are past tense; `node.` is
 * connection-level (`node.authenticate` proves the node before and `node.hello` negotiates the epoch the
 * tables' methods carry, so they are in neither). */
export const methods = { nodeAuthenticate: "node.authenticate", nodeHello: "node.hello", nodePing: HEARTBEAT_METHOD, ...methodKeys(nodeMethods), ...methodKeys(serverMethods) } as const;
/** Upper bound on `node.hello`'s `liveSessions`. */
export const MAX_LIVE_SESSIONS = 4096;
/** Upper bound on `node.hello`'s `sources`, and on one source path's length. */
export const MAX_DECLARED_SOURCES = 1024;
export const MAX_SOURCE_PATH_CHARS = 4096;
/**
 * `node.hello`'s params. Bootstrap surface (ADR-025): a server must read the hello of a node of any release
 * far enough to tell it to update, so this envelope only grows. It parses tolerantly: fields a newer node
 * sends that this server does not know are dropped, not refused.
 */
export const helloParams = z.object({
  minVersion: z.number().int().positive(), maxVersion: z.number().int().positive(),
  capabilities: z.array(id).max(16),
  /** The connecting node's ID: the server serves the connection only for a node it knows (a `nodes` row). */
  nodeId: id,
  /** Sessions with a run in progress on the node when it dialed. After negotiation the server resumes
   * every other session on this node it still sees running: the node lost its run (ADR-021). */
  liveSessions: z.array(id).max(MAX_LIVE_SESSIONS),
  /** The checkouts the node serves, as declared on its machine (`reins node source add`): absolute paths.
   * The node refuses every call naming another checkout. Absent: the node declares none and serves any
   * path (the local node, on the server's machine). The server records them at each hello. */
  sources: z.array(z.string().min(1).max(MAX_SOURCE_PATH_CHARS).startsWith("/")).max(MAX_DECLARED_SOURCES).optional(),
  /** The node bundle it runs: the sha256 of its `reins.js`. Absent from source (the local node). A server
   * whose own build differs answers `update` instead of negotiating. */
  buildId: sha256.optional(),
}).refine(value => value.minVersion <= value.maxVersion);

/** The hello's reply, by `kind` (ADR-025). Bootstrap surface: a node reads the reply of a server of any
 * later release, so kinds and fields are only added, and a node parses tolerantly (`helloReply`). */
export const readyResult = z.object({
  kind: z.literal("ready"),
  version: z.literal(protocolVersion), capabilities: z.array(capability).max(16), epoch: z.string().uuid(),
});
/** Install this build and restart on it, instead of negotiating: from `<server>/nodes/builds/<buildId>/reins.js`
 * on the server the node is paired with, checked against `sha256`, on Bun `bunVersion`. */
export const updateResult = z.object({
  kind: z.literal("update"),
  buildId: sha256, sha256, bunVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/).max(64),
});
/** The server cannot serve this node at all (e.g. a bootstrap format it no longer accepts): the node stops,
 * and the user reinstalls it. */
export const helloErrorResult = z.object({
  kind: z.literal("error"),
  code: z.string().min(1).max(64), message: z.string().max(MAX_ERROR_MESSAGE),
});
/** What a server answers, checked as it sends it. */
export const helloResult = z.discriminatedUnion("kind", [readyResult, updateResult, helloErrorResult]);
/** What a node accepts as a reply before reading its kind (`helloReply`). */
const helloEnvelope = z.looseObject({ kind: z.string().max(64) });
export type Hello = z.infer<typeof helloParams>;
export type Ready = z.infer<typeof readyResult>;
export type HelloResult = z.infer<typeof helloResult>;
/** The build an `update` reply names. */
export type BuildUpdate = Omit<z.infer<typeof updateResult>, "kind">;

/** A hello answered `update`: the connection did not negotiate, and the node should install `update` and
 * restart on it. */
export class UpdateRequired extends Error {
  constructor(readonly update: BuildUpdate) {
    super(`The server runs build ${update.buildId}`);
    this.name = "UpdateRequired";
  }
}

/** A node's reading of the hello's reply: `ready` negotiates; `update` throws `UpdateRequired`; `error`, an
 * unknown kind or a malformed `update` throws `NODE_REFUSED` (the node stops: retrying cannot help, and a
 * reply it cannot read means it must be reinstalled). A malformed `ready` is a malformed reply, as before. */
function helloReply(reply: z.infer<typeof helloEnvelope>): Ready {
  const unreadable = () => new RpcFailure(NODE_REFUSED, `The server answered the hello with a reply this node does not understand (${reply.kind}); reinstall the node`);
  switch (reply.kind) {
    case "ready": {
      const ready = readyResult.safeParse(reply);
      if (!ready.success) throw new RpcFailure(INTERNAL_ERROR, "Invalid response");
      return ready.data;
    }
    case "update": {
      const update = updateResult.safeParse(reply);
      if (!update.success) throw unreadable();
      const { kind: _, ...build } = update.data;
      throw new UpdateRequired(build);
    }
    case "error": {
      const error = helloErrorResult.safeParse(reply);
      if (!error.success) throw unreadable();
      throw new RpcFailure(NODE_REFUSED, `The server cannot serve this node (${error.data.code}): ${error.data.message}`);
    }
    default:
      throw unreadable();
  }
}

/** Session commands the node serves, one handler per wire method (the node advertises each as a
 * capability). A handler rejects with an `RpcFailure` (e.g. `APPLICATION_ERROR` whose data is a
 * `NodeError`). */
export interface NodeCommandHandlers {
  prompt(input: SessionInput): Promise<{ inputId: string }>;
  steer(input: SessionInput): Promise<{ inputId: string }>;
  setModel(input: SessionSetModel): Promise<{ modelSet: true }>;
  abort(input: SessionAbort): Promise<{ aborted: boolean }>;
  resumePending(input: SessionResume): Promise<{ started: boolean }>;
  close(input: SessionClose): Promise<{ closed: boolean }>;
  /** `skills.list`: read-only, not a session command. */
  listSkills(input: SkillsList): Promise<SkillsListResult>;
  /** `process.run`: checks the request and returns the source of its stream, which starts the process
   * (the connection serves it under the request's `streamId` and answers `{}`). */
  runProcess(input: ProcessRun): Promise<OpenStreamSource>;
  /** `fs.list`. */
  listDirectory(input: FsList): Promise<FsListResult>;
  /** `fs.read`: checks the request and returns the file's size and the source of its (binary) stream. */
  readFile(input: FsRead): Promise<FsReadResult & { source: OpenStreamSource }>;
  /** `fs.write`. */
  writeFile(input: FsWrite): Promise<FsWriteResult>;
  /** `credentials.changed`, a notification: drop the provider's cached credential. */
  credentialsChanged(input: CredentialsChanged): void;
  /** `node.reload`: answers before the reload happens (see `nodeReloadParams`). */
  reload(input: NodeReload): Promise<{ scheduled: true }>;
}
export interface NodeConnectionOptions extends Hello, LinkOptions, NodeCommandHandlers {
  /** A paired node's identity: the node answers the server's `node.authenticate` challenge with it, as
   * the hello's node. Without it, a challenge is refused (method not found). The hello is sent at once
   * either way: an authenticating server answers it only once the challenge is. */
  identity?: NodeIdentity;
}

/** The node side of one negotiated connection over `socket`: serves `options`' session commands and
 * returns the server calls. Owns no socket creation, storage or process lifecycle (see `connectNode`). */
export function createNodeConnection(socket: WireSocket, options: NodeConnectionOptions) {
  const hello = helloParams.parse({
    nodeId: options.nodeId, minVersion: options.minVersion, maxVersion: options.maxVersion, capabilities: options.capabilities, liveSessions: options.liveSessions,
    ...(options.sources ? { sources: options.sources } : {}), ...(options.buildId ? { buildId: options.buildId } : {}),
  });
  const { identity } = options;
  let negotiated: Ready | undefined;
  /** The server sends commands as soon as it has answered hello (a reconnect replays queued work at
   * once), so a command can arrive in the same read as the reply, before this side has processed it:
   * wait for negotiation to settle before checking the epoch. */
  const authorized = async (epoch: string, required: Capability) => {
    await ready.catch(() => undefined);
    if (!negotiated || epoch !== negotiated.epoch || !negotiated.capabilities.includes(required)) throw new RpcFailure(UNAUTHORIZED, "Stale or unauthorized connection");
  };
  // With an identity, the server's challenge: before any epoch, so served directly (as the server serves
  // `node.hello`).
  const authentication: RpcHandlers = identity ? {
    [methods.nodeAuthenticate]: {
      params: authenticateParams, result: authenticateResult,
      handle: async (challenge: NodeChallenge) => signNodeChallenge(identity, hello.nodeId, challenge),
    },
  } : {};
  // Server→node commands: the epoch and capability are checked before the handler runs.
  const peer = createRpcPeer(socket, { ...authentication, ...serveMethods(nodeMethods, {
    "session.prompt": options.prompt, "session.steer": options.steer, "session.setModel": options.setModel, "session.abort": options.abort,
    "session.resumePending": options.resumePending, "session.close": options.close, "skills.list": options.listSkills,
    "process.run": async input => {
      const source = await options.runProcess(input);
      void streams.serve(input.streamId, source, { binary: input.binary });
      return {};
    },
    "fs.list": options.listDirectory,
    "fs.read": async input => {
      const { source, ...result } = await options.readFile(input);
      void streams.serve(input.streamId, source, { binary: true });
      return result;
    },
    "fs.write": options.writeFile,
    "stream.cancel": ({ streamId }) => streams.cancel(streamId),
    "credentials.changed": options.credentialsChanged,
    "node.reload": options.reload,
  }, authorized) }, { maxFrameBytes: options.maxFrameBytes, heartbeat: options.heartbeat, timers: options.timers });
  const server = methodClient(peer, serverMethods);
  // Storage payloads longer than this cross in slices (`storage.readPart`, `storage.commitPart`).
  const storageChunk = storageChunkChars(options.maxFrameBytes);
  /** A storage reply, fetching the rest of one the server held (on the connection that holds it) and
   * checking the whole against `schema`, as the peer checks a reply that came whole. */
  const whole = async <T>(current: string, reply: T | HeldStorageReply, schema: z.ZodType<T>): Promise<T> => {
    if (!isHeld(reply)) return reply;
    let json = reply.data;
    while (json.length < reply.length) {
      const { data } = await server.call("storage.readPart", current, { replyId: reply.replyId, offset: json.length });
      if (json.length + data.length > reply.length) throw new RpcFailure(INTERNAL_ERROR, `Storage reply slice out of range: ${reply.replyId}`);
      json += data;
    }
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw new RpcFailure(INTERNAL_ERROR, "Invalid storage reply"); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RpcFailure(INTERNAL_ERROR, "Invalid storage reply");
    return parsed.data;
  };
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
  const ready = peer.call(methods.nodeHello, hello, helloEnvelope).finally(() => { if (helloTimer !== undefined) timers.clearTimeout(helloTimer); }).then(reply => {
    const value = helloReply(reply);
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
     * unknown outcome and is not retried here. A payload longer than this link's storage chunk crosses in
     * slices on this connection (`storage.readPart`, `storage.commitPart`), each its own call: one that
     * fails fails the whole read or commit, which a caller may make again from the start. */
    async readStorage(input: StorageRead): Promise<StorageReadResult> {
      const current = await epoch();
      return whole(current, await server.call("storage.read", current, input), storageReadResult);
    },
    /** Writes longer than the storage chunk are uploaded slice by slice and applied with the last,
     * continuing from the server's `nextOffset` (an evicted upload restarts). */
    async commitStorage(input: StorageCommit): Promise<StorageCommitResult> {
      const current = await epoch();
      const json = JSON.stringify(input.writes);
      if (json.length <= storageChunk) return whole(current, await server.call("storage.commit", current, input), storageCommitResult);
      const { sessionId, commitId } = input;
      // Every slice at most twice (one restart after an evicted upload) plus the answer.
      const limit = 2 * Math.ceil(json.length / storageChunk) + 2;
      for (let offset = 0, calls = 0; calls < limit; calls++) {
        const reply = await server.call("storage.commitPart", current, { sessionId, commitId, length: json.length, offset, data: json.slice(offset, offset + storageChunk) });
        if (!("nextOffset" in reply)) return whole(current, reply, storageCommitResult);
        if (reply.nextOffset >= json.length) throw new RpcFailure(APPLICATION_ERROR, `Storage commit upload offset out of range: ${commitId}`);
        offset = reply.nextOffset;
      }
      throw new RpcFailure(APPLICATION_ERROR, `Storage commit upload did not complete: ${commitId}`);
    },
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

const isHeld = (reply: unknown): reply is HeldStorageReply => typeof reply === "object" && reply !== null && "replyId" in reply;
