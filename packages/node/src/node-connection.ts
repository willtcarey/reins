/**
 * The node end of the node's connection to its server (node-transport.md *4. The connection*, *Details:
 * reconnecting*; ADR-027): `connectNode` keeps a `Node` linked to its server over a `Transport`, one socket
 * at a time, until stopped.
 *
 * On each socket it answers the server's challenge with the node's key, says hello (the protocol version,
 * its build and where its docs are), and serves each server→node method from the node's
 * command (a `NodeRejection` keeps its code on the wire; any other exception is `internal`) and the
 * streams `process.run`, `fs.read`, `pi.exec` and `pi.execAttach` open, until it closes. The
 * node calls nothing on the server: only its streams' frames go that way. Across sockets it redials,
 * refuses to go on when the server refuses the node, and hands
 * an update the server asks for to `onUpdate`. The transports are adapters at its seam: `unixTransport`
 * (local-link.ts), `webSocketTransport` (remote-link.ts) and the in-memory ones of tests.
 */
import { z } from "zod";
import {
  APPLICATION_ERROR, INTERNAL_ERROR, MAX_ERROR_MESSAGE, NEGOTIATION_FAILED, NODE_REFUSED, NodeRejection, RpcFailure, UNAUTHORIZED,
  authenticateParams, authenticateResult, createRpcPeer, helloErrorResult, helloParams, methodClient, methods, nodeMethods, protocolVersion, readyResult,
  serveMethods, serverMethods, signNodeChallenge, systemTimers, updateResult,
  type BuildUpdate, type Hello, type LinkOptions, type LinkSocket, type NodeChallenge, type NodeDocs, type NodeError,
  type NodeKey, type Ready, type RpcHandlers,
} from "@reins/node-protocol";
import type { Node, NodeCommands } from "./node.js";
import { reinsDocs } from "./docs.js";
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
 * drops, and again with `failure` each time an attempt fails for another reason than the last (why it is
 * not connected: the server unreachable, a failed hello, a failed update); `connected` once a connection
 * negotiates; and `refused` with the server's reason (final: the server will not serve this node). */
export type LinkState = { state: "connecting"; failure?: string } | { state: "connected" } | { state: "refused"; message: string };

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
  /** Where its REINS docs are, announced in every hello: `reinsDocs()` by default. */
  docs?: NodeDocs;
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
 * A hello answered `update` (ADR-025) goes to `onUpdate`. Its shell commands outlive a connection: the
 * server picks them up again on the next (node-contract.md *Shell commands*).
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
  /** Why the last attempt failed, since the last connection negotiated. */
  let lastFailure: string | undefined;
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
  /** An attempt failed: says why (logged unless the caller did) when the reason is new. */
  const failed = (failure: string, { logged = false } = {}) => {
    if (stopped || failure === lastFailure) return;
    lastFailure = failure;
    if (!logged) console.warn(`[node] not connected: ${failure}`);
    onState?.({ state: "connecting", failure });
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
      const failure = `updating to build ${target.buildId.slice(0, 12)} failed: ${messageOf(error)}`;
      console.warn(`[node] ${failure}; asking the server again in ${Math.round(ms / 1000)} s`);
      failed(failure, { logged: true });
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
      lastFailure = undefined;
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
      failed(`negotiation failed: ${messageOf(error)}`);
    });
  };
  const connect = async () => {
    if (stopped) return;
    // Nothing listening, unreachable, or the endpoint refused the connection: try again later.
    try { await transport.open(opened); } catch (error) { failed(`cannot reach the server: ${messageOf(error)}`); schedule(); }
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

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

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

/** The node end of one socket: says hello and serves `node`'s commands once negotiated, until `close()`.
 * `ready` settles with the negotiation. */
function openConnection(node: Node, wire: LinkSocket, { nodeId, key, buildId, docs = reinsDocs() }: ConnectNodeOptions, link: LinkOptions) {
  const hello: Hello = helloParams.parse({ nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, ...(buildId ? { buildId } : {}), docs });
  // Bootstrap surface (ADR-025): servers before protocol 12 require `liveSessions` and servers before 15
  // `capabilities` in the hello, and must read this one far enough to tell this node which build to run.
  const sent = { ...hello, liveSessions: [], capabilities: [] };
  let negotiated: Ready | undefined;
  /** The server sends commands as soon as it has answered hello (a tool call waiting for this node goes
   * out at once), so a command can arrive in the same read as the reply, before this side has processed it:
   * wait for negotiation to settle before serving it. */
  const authorized = async () => {
    await ready.catch(() => undefined);
    if (!negotiated) throw new RpcFailure(UNAUTHORIZED, "Not negotiated");
  };
  // With a key, the server's challenge: before negotiation, so served directly (as the server serves
  // `node.hello`).
  const authentication: RpcHandlers = key ? {
    [methods.nodeAuthenticate]: {
      params: authenticateParams, result: authenticateResult,
      handle: async (challenge: NodeChallenge) => signNodeChallenge(key, hello.nodeId, challenge),
    },
  } : {};
  const commands: NodeCommands = {
    runProcess: served(input => node.runProcess(input)),
    fileInfo: served(input => node.fileInfo(input)), listDirectory: served(input => node.listDirectory(input)),
    readFile: served(input => node.readFile(input)), writeFile: served(input => node.writeFile(input)),
    absolutePath: served(input => node.absolutePath(input)), canonicalPath: served(input => node.canonicalPath(input)),
    reload: served(input => node.reload(input)),
    piExec: served(input => node.piExec(input)), piExecAttach: served(input => node.piExecAttach(input)), piExecKill: served(input => node.piExecKill(input)),
  };
  // Server→node commands: served once the connection negotiated.
  const peer = createRpcPeer(wire, { ...authentication, ...serveMethods(nodeMethods, {
    "process.run": async input => {
      const source = await commands.runProcess(input);
      void streams.serve(input.streamId, source, { binary: input.binary });
      return {};
    },
    "fs.info": commands.fileInfo,
    "fs.list": commands.listDirectory,
    "fs.read": async input => {
      const { result, source } = await commands.readFile(input);
      void streams.serve(input.streamId, source, { binary: true });
      return result;
    },
    "fs.write": commands.writeFile,
    "fs.absolutePath": commands.absolutePath,
    "fs.canonicalPath": commands.canonicalPath,
    "stream.cancel": ({ streamId }) => streams.cancel(streamId),
    "node.reload": commands.reload,
    "pi.exec": async input => {
      const source = await commands.piExec(input);
      void streams.serve(input.streamId, source);
      return {};
    },
    "pi.execAttach": async input => {
      const { result, source } = await commands.piExecAttach(input);
      void streams.serve(input.streamId, source);
      return result;
    },
    "pi.execKill": commands.piExecKill,
  }, authorized) }, { maxFrameBytes: link.maxFrameBytes, heartbeat: link.heartbeat, timers: link.timers });
  const server = methodClient(peer, serverMethods);
  // Streams belong to this connection: chunks go out once it negotiated and stop when it closes.
  const streams = createStreamSender({
    data: input => !!negotiated && server.notify("stream.data", input),
    end: input => !!negotiated && server.notify("stream.end", input),
    drained: () => peer.drained(),
  });
  // Negotiation bound: closing fails the pending hello, so `ready` rejects.
  const timers = link.timers ?? systemTimers;
  const helloTimer = link.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!negotiated) { console.warn(`Node negotiation timed out after ${link.helloTimeoutMs}ms; closing the connection`); peer.close(); }
  }, link.helloTimeoutMs);
  const ready = peer.call(methods.nodeHello, sent, helloEnvelope).finally(() => { if (helloTimer !== undefined) timers.clearTimeout(helloTimer); }).then(reply => {
    const value = helloReply(reply);
    if (value.version < hello.minVersion || value.version > hello.maxVersion) {
      peer.close(); throw new RpcFailure(NEGOTIATION_FAILED, "Invalid negotiation");
    }
    negotiated = value;
    return value;
  }).catch((error: unknown) => {
    // A connection that failed to negotiate (rejected, timed out, closed) serves nothing: close it.
    peer.close();
    throw error;
  });
  return {
    receive: peer.receive, ready,
    close() { streams.close(); peer.close(); },
  };
}
