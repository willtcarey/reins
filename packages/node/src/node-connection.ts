/**
 * The node end of the node's connection to its server (node-transport.md *4. The connection*, *Details:
 * reconnecting*; ADR-027): `connectNode` keeps a `Node` linked to its server over a `Transport`, one socket
 * at a time, until stopped.
 *
 * On each socket it answers the server's challenge with the node's key, says hello (the protocol version,
 * every command as a capability, the node's live sessions and its build), serves each server→node method
 * from the node's command (a `NodeRejection` keeps its code on the wire; any other exception is
 * `internal`) and the streams `process.run`, `fs.read`, `env.fs`, `env.exec` and `env.execAttach` open, and attaches the socket's server calls to
 * the node (storage, slicing what is too long for a frame; reports; credentials; attachments; tool calls)
 * until it closes. Across sockets it redials, refuses to go on when the server refuses the node, and hands
 * an update the server asks for to `onUpdate`. The transports are adapters at its seam: `unixTransport`
 * (local-link.ts), `webSocketTransport` (remote-link.ts) and the in-memory ones of tests.
 */
import { z } from "zod";
import {
  APPLICATION_ERROR, ATTACHMENT_CHUNK_BYTES, INTERNAL_ERROR, MAX_ERROR_MESSAGE, NEGOTIATION_FAILED, NODE_REFUSED, NodeRejection, NotConnected, RpcFailure, UNAUTHORIZED,
  authenticateParams, authenticateResult, createRpcPeer, helloErrorResult, helloParams, methodClient, methods, nodeMethods, protocolVersion, readyResult,
  serveMethods, serverMethods, signNodeChallenge, storageChunkChars, storageCommitResult, storageReadResult, systemTimers, updateResult,
  type AttachmentChunk, type BuildUpdate, type Capability, type Hello, type HeldStorageReply, type LinkOptions, type LinkSocket, type NodeChallenge, type NodeError,
  type NodeKey, type Ready, type RpcHandlers,
} from "@reins/node-protocol";
import type { Node, NodeCommands, NodeServer } from "./node.js";
import { createStreamSender } from "./node-connection/streams.js";

/** How a node reaches its server: one connection at a time. Its adapters are `unixTransport`
 * (local-link.ts), `webSocketTransport` (remote-link.ts) and the in-memory transports of tests. */
export interface Transport {
  /** Where it connects, for the log: the socket's path or the URL. */
  readonly address: string;
  /** The link's options over this transport: its frame cap, heartbeat and hello timeout (and, in tests,
   * its timers, which the redial backoff uses too). */
  readonly link: LinkOptions;
  /** Opens one connection: calls `opened` with its socket as soon as it is open (before any frame can
   * arrive), and rejects when no connection opened. */
  open(opened: (wire: LinkSocket) => void): Promise<unknown>;
}

/** The node's link as `connectNode` reports it: `connecting` (again) whenever a negotiated connection
 * drops, `connected` once a connection negotiates, and `refused` with the server's reason (final: the
 * server will not serve this node). */
export type LinkState = { state: "connecting" } | { state: "connected" } | { state: "refused"; message: string };

export interface ConnectNodeOptions {
  /** The node's ID, announced in every hello: the server serves the connection only for a node it knows. */
  nodeId: string;
  /** A paired node's key: it answers the server's `node.authenticate` challenge with it, as `nodeId`.
   * Absent for the local node, whose socket does not challenge; a node without a key refuses a challenge
   * (method not found), so it fails authentication. The hello is sent at once either way: an
   * authenticating server answers it only once the challenge is. */
  key?: NodeKey;
  /** The node bundle it runs (the sha256 of its `reins.js`), announced in every hello; absent from
   * source. A server on another build answers `update` instead of negotiating. */
  buildId?: string;
  /** Hears each change of the link's state. */
  onState?: (link: LinkState) => void;
  /** Installs the build an `update` reply names; while it runs nothing is dialed. Resolved, the link stops
   * (the node restarts on the build); rejected, the server is asked again after the update backoff.
   * Without it, an update is reported as a refusal: this node cannot update itself. */
  onUpdate?: (update: BuildUpdate) => Promise<void>;
}

/** Reconnect delays: exponential from `initialMs`, capped at `maxMs`, with "equal jitter" (each delay is
 * uniformly random in [d/2, d]) so many nodes restarting together do not dial in lockstep. */
export interface Backoff { initialMs: number; maxMs: number }
/** Tests only: the backoffs and the jitter's random source. */
export interface ConnectTuning { backoff?: Backoff; updateBackoff?: Backoff; random?: () => number }
const RECONNECT_BACKOFF: Backoff = { initialMs: 100, maxMs: 5_000 };
/** Between failed updates: each asks the server again, and may download a build, so not too often. */
const UPDATE_BACKOFF: Backoff = { initialMs: 5_000, maxMs: 300_000 };

/**
 * Links `node` to its server over `transport` until `stop()`: dials, runs the node end of the connection on
 * each socket (see the file's comment) and redials whenever a dial fails, the connection closes or its
 * hello fails for a reason retrying may cure (no common protocol version, a timeout; logged), after a
 * backoff (100 ms doubling to 5 s) that resets once a connection negotiates. A hello the server refuses
 * (`NODE_REFUSED`: an unknown or revoked node, or failed authentication), or answers in a way this node
 * cannot read, stops it instead: it never dials again and reports `refused` with the server's reason, once.
 * A hello answered `update` (ADR-025) goes to `onUpdate`. Every connection is a new attach: the node
 * announces its live sessions and drops its credential cache; runtimes outlive it, and the node's calls
 * that were never sent wait for the next (node-contract.md *Link loss*).
 *
 * `stop()` closes the current connection and never dials again; call it before stopping the node. `tuning`
 * is for tests.
 */
export function connectNode(node: Node, transport: Transport, options: ConnectNodeOptions, { backoff = RECONNECT_BACKOFF, updateBackoff = UPDATE_BACKOFF, random = Math.random }: ConnectTuning = {}): { stop(): void } {
  const { link } = transport;
  const { onState, onUpdate } = options;
  const timers = link.timers ?? systemTimers;
  let stopped = false;
  let updating = false;
  let attempt = 0;
  let updateFailures = 0;
  let timer: unknown;
  let current: { close(): void } | undefined;
  const delay = ({ initialMs, maxMs }: Backoff, failures: number) => {
    const ceiling = Math.min(maxMs, initialMs * 2 ** failures);
    return ceiling / 2 + random() * ceiling / 2;
  };
  /** Dials again after `ms`, by default the next reconnect backoff; not while an update runs. */
  const schedule = (ms?: number) => {
    if (stopped || updating || timer !== undefined) return;
    timer = timers.setTimeout(() => { timer = undefined; void connect(); }, ms ?? delay(backoff, attempt++));
  };
  const refuse = (message: string) => {
    stop();
    onState?.({ state: "refused", message });
  };
  /** The server runs another build: install it (dialing nothing meanwhile), and ask again later if that fails. */
  const update = (target: BuildUpdate) => {
    if (!onUpdate) { refuse(`The server runs build ${target.buildId.slice(0, 12)}, and this node cannot update itself`); return; }
    updating = true;
    if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
    onUpdate(target).then(() => stop(), (error: unknown) => {
      updating = false;
      if (stopped) return;
      const ms = delay(updateBackoff, updateFailures++);
      console.warn(`[node] updating to build ${target.buildId.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}; asking the server again in ${Math.round(ms / 1000)} s`);
      schedule(ms);
    });
  };
  const opened = (wire: LinkSocket) => {
    if (stopped) { wire.close(); return; }
    const connection = openConnection(node, wire, options, link);
    current = connection;
    let negotiated = false;
    wire.onmessage = connection.receive;
    wire.onclose = () => {
      connection.close();
      if (current === connection) current = undefined;
      if (negotiated && !stopped) onState?.({ state: "connecting" });
      schedule();
    };
    connection.ready.then(() => {
      attempt = 0;
      updateFailures = 0;
      if (wire.closed) return;
      negotiated = true;
      onState?.({ state: "connected" });
    }, (error: unknown) => {
      if (stopped) return;
      if (error instanceof UpdateRequired) { update(error.update); return; }
      // The server will not serve this node: redialing cannot help.
      if (error instanceof RpcFailure && error.code === NODE_REFUSED) { refuse(error.message); return; }
      // Any other failed hello (no common protocol version, a timeout) is retried like a failed dial;
      // say why, since nothing else will.
      console.warn(`[node] negotiation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const connect = async () => {
    if (stopped) return;
    // Nothing listening, unreachable, or the endpoint refused the connection: try again later.
    try { await transport.open(opened); } catch { schedule(); }
  };
  function stop() {
    stopped = true;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    current?.close();
    current = undefined;
  }
  void connect();
  return { stop };
}

/** Every command the node serves, advertised in its hello (with `stream.cancel`: it serves streams). */
const CAPABILITIES: Capability[] = [
  methods.sessionPrompt, methods.sessionSteer, methods.sessionSetModel, methods.sessionAbort, methods.sessionResumePending, methods.sessionClose,
  methods.skillsList, methods.processRun, methods.fsList, methods.fsRead, methods.fsWrite, methods.streamCancel, methods.credentialsChanged, methods.nodeReload,
  methods.envFs, methods.envExec, methods.envExecAttach, methods.envExecKill, methods.checkoutEnvironment,
];

/** A hello answered `update`: the connection did not negotiate, and the node should install `update` and
 * restart on it. */
class UpdateRequired extends Error {
  constructor(readonly update: BuildUpdate) {
    super(`The server runs build ${update.buildId}`);
    this.name = "UpdateRequired";
  }
}

/** What the node accepts as a hello reply before reading its kind (`helloReply`): bootstrap surface, read
 * tolerantly. */
const helloEnvelope = z.looseObject({ kind: z.string().max(64) });

/** The node's reading of the hello's reply: `ready` negotiates; `update` throws `UpdateRequired`; `error`, an
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

const rejection = (error: NodeError) => {
  const message = error.message.slice(0, MAX_ERROR_MESSAGE);
  return new RpcFailure(APPLICATION_ERROR, message, undefined, { ...error, message });
};
/** A `NodeRejection` keeps its code; any other exception thrown by node code is `internal`. */
const served = <I, O>(handle: (input: I) => Promise<O>) => async (input: I): Promise<O> => {
  try { return await handle(input); }
  catch (error) {
    if (error instanceof NodeRejection) throw rejection(error.error);
    throw rejection({ code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false });
  }
};

const isHeld = (reply: unknown): reply is HeldStorageReply => typeof reply === "object" && reply !== null && "replyId" in reply;

/** The node end of one socket: says hello, serves `node`'s commands once negotiated and attaches the
 * socket's server calls to `node` until `close()`. `ready` settles with the negotiation. */
function openConnection(node: Node, wire: LinkSocket, { nodeId, key, buildId }: ConnectNodeOptions, link: LinkOptions) {
  const hello: Hello = helloParams.parse({
    nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: CAPABILITIES,
    // Read when dialing: the runs this node still has in progress (see `Node.liveSessions`).
    liveSessions: node.liveSessions(),
    ...(buildId ? { buildId } : {}),
  });
  let negotiated: Ready | undefined;
  /** The server sends commands as soon as it has answered hello (a reconnect replays queued work at
   * once), so a command can arrive in the same read as the reply, before this side has processed it:
   * wait for negotiation to settle before checking the epoch. */
  const authorized = async (epoch: string, required: Capability) => {
    await ready.catch(() => undefined);
    if (!negotiated || epoch !== negotiated.epoch || !negotiated.capabilities.includes(required)) throw new RpcFailure(UNAUTHORIZED, "Stale or unauthorized connection");
  };
  // With a key, the server's challenge: before any epoch, so served directly (as the server serves
  // `node.hello`).
  const authentication: RpcHandlers = key ? {
    [methods.nodeAuthenticate]: {
      params: authenticateParams, result: authenticateResult,
      handle: async (challenge: NodeChallenge) => signNodeChallenge(key, hello.nodeId, challenge),
    },
  } : {};
  const commands: Omit<NodeCommands, "credentialsChanged"> = {
    prompt: served(input => node.prompt(input)), steer: served(input => node.steer(input)),
    setModel: served(input => node.setModel(input)), abort: served(input => node.abort(input)),
    resumePending: served(input => node.resumePending(input)), close: served(input => node.close(input)),
    listSkills: served(input => node.listSkills(input)),
    runProcess: served(input => node.runProcess(input)), listDirectory: served(input => node.listDirectory(input)),
    readFile: served(input => node.readFile(input)), writeFile: served(input => node.writeFile(input)),
    reload: served(input => node.reload(input)),
    envFs: served(input => node.envFs(input)), envExec: served(input => node.envExec(input)),
    envExecAttach: served(input => node.envExecAttach(input)), envExecKill: served(input => node.envExecKill(input)),
    checkoutEnvironment: served(input => node.checkoutEnvironment(input)),
  };
  // Server→node commands: the epoch and capability are checked before the command runs.
  const peer = createRpcPeer(wire, { ...authentication, ...serveMethods(nodeMethods, {
    "session.prompt": commands.prompt, "session.steer": commands.steer, "session.setModel": commands.setModel, "session.abort": commands.abort,
    "session.resumePending": commands.resumePending, "session.close": commands.close, "skills.list": commands.listSkills,
    "process.run": async input => {
      const source = await commands.runProcess(input);
      void streams.serve(input.streamId, source, { binary: input.binary });
      return {};
    },
    "fs.list": commands.listDirectory,
    "fs.read": async input => {
      const { source, ...result } = await commands.readFile(input);
      void streams.serve(input.streamId, source, { binary: true });
      return result;
    },
    "fs.write": commands.writeFile,
    "stream.cancel": ({ streamId }) => streams.cancel(streamId),
    "credentials.changed": input => node.credentialsChanged(input),
    "node.reload": commands.reload,
    "env.fs": async input => {
      const { result, source } = await commands.envFs(input);
      void streams.serve(input.streamId, source, { binary: true });
      return result;
    },
    "env.exec": async input => {
      const source = await commands.envExec(input);
      void streams.serve(input.streamId, source);
      return {};
    },
    "env.execAttach": async input => {
      const { result, source } = await commands.envExecAttach(input);
      void streams.serve(input.streamId, source);
      return result;
    },
    "env.execKill": commands.envExecKill,
    "checkout.environment": commands.checkoutEnvironment,
  }, authorized) }, { maxFrameBytes: link.maxFrameBytes, heartbeat: link.heartbeat, timers: link.timers });
  const server = methodClient(peer, serverMethods);
  // Storage payloads longer than this cross in slices (`storage.readPart`, `storage.commitPart`).
  const storageChunk = storageChunkChars(link.maxFrameBytes);
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
  const timers = link.timers ?? systemTimers;
  const helloTimer = link.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!negotiated) { console.warn(`Node negotiation timed out after ${link.helloTimeoutMs}ms; closing the connection`); peer.close(); }
  }, link.helloTimeoutMs);
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
  /** The node's calls to the server over this connection (`Node.attach`). */
  const serverCalls: NodeServer = {
    /** Best effort and ordered: waits for negotiation, then notifies; dropped if negotiation fails or the frame is unsendable. */
    event(input) {
      void ready.then(value => {
        if (!server.notify("session.event", value.epoch, input)) console.warn(`Dropped session event ${input.sessionId}#${input.seq}`);
      }, () => undefined);
    },
    /** Lifecycle reports and uploads: a server rejection may carry a `NodeError` as `data` (`not_owner` when
     * the session's source is not on this node). */
    async started(input) { await server.call("session.started", await epoch(), input); },
    async settled(input) { await server.call("session.settled", await epoch(), input); },
    /** On abort or timeout (outcome unknown) also sends a best-effort `script.cancel`, which aborts
     * the script's signal on the server. */
    async executeScript(input, signal) {
      const current = await epoch();
      const callId = crypto.randomUUID();
      try {
        return await server.call("script.execute", current, { ...input, callId }, { signal });
      } catch (error) {
        if (error instanceof RpcFailure && error.outcome === "unknown") server.notify("script.cancel", current, { sessionId: input.sessionId, callId });
        throw error;
      }
    },
    async searchScript(input, signal) { return server.call("script.search", await epoch(), input, { signal }); },
    async createTask(input, signal) { return server.call("project.createTask", await epoch(), input, { signal }); },
    /** Credentials the server holds; a rejection carries a `NodeError` as `data`. */
    async getCredential(providerId, signal) {
      return (await server.call("credentials.get", await epoch(), { providerId }, { signal })).credential;
    },
    /** The server refreshes the login (at most once, under its own serialization) and returns the current credential. */
    async refreshCredential(providerId, signal) {
      return (await server.call("credentials.refresh", await epoch(), { providerId }, { signal })).credential;
    },
    async listCredentials(signal) {
      return (await server.call("credentials.list", await epoch(), {}, { signal })).credentials;
    },
    /** Uploads node-created bytes under the node-assigned ID in chunks, continuing from the server's
     * `nextOffset` (a retried or evicted partial upload resumes or restarts). Each chunk call has its own
     * timeout; a failure leaves the outcome unknown, which is safe to retry because the server answers a
     * repeated ID with the same content as stored. */
    async storeAttachment(input) {
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
    async readStorage(input) {
      const current = await epoch();
      return whole(current, await server.call("storage.read", current, input), storageReadResult);
    },
    /** Writes longer than the storage chunk are uploaded slice by slice and applied with the last,
     * continuing from the server's `nextOffset` (an evicted upload restarts). */
    async commitStorage(input) {
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
    async fetchAttachment(sessionId, attachmentId) {
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
  const detach = node.attach(serverCalls);
  ready.catch(detach);
  return {
    receive: peer.receive, ready,
    close() { detach(); streams.close(); peer.close(); },
  };
}
