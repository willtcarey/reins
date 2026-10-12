/**
 * The server end of one node connection: process-owned, served by the process's hub (`node-hub.ts`;
 * restart-only, docs/dev/hot-reload.md *Ownership*).
 */
import { logger } from "../logger.js";
import { createRpcPeer, RpcFailure, helloParams, helloResult, protocolVersion, type BuildUpdate, type HelloResult, methods, nodeMethods, serverMethods, serveMethods, methodClient, type MethodInput, type MethodCallOptions, type RequestMethod, capability, type Capability, type WireSocket, type LinkOptions, type Hello, type Ready, systemTimers, NEGOTIATION_FAILED, UNAUTHORIZED, NODE_REFUSED, NotConnected, authenticateResult, newNodeChallenge, verifyNodeAnswer } from "@reins/node-protocol";
import { createStreamRegistry, type NodeStream } from "./node-streams.js";

/** A negotiated connection: the hello reply, the node ID the node announced and the build it runs (null:
 * from source). */
export type Negotiated = Ready & { nodeId: string; buildId: string | null };
/** Checks, once per connection, that the server serves the node ID announced in `node.hello`; throws to
 * refuse the hello (the connection then serves nothing): an `RpcFailure` is the answer (`NODE_REFUSED` for
 * a node the server will not serve, `NEGOTIATION_FAILED` for one it cannot answer yet), anything else is
 * answered `UNAUTHORIZED`. */
export type ServeNode = (nodeId: string) => Promise<void> | void;

/** How a connection authenticates its node: the origin the node must have signed for (the server origin
 * this transport serves), and the public key a node must prove it holds (base64url of the raw Ed25519 key;
 * null for an unknown or unpaired node, which is refused). Revocation is not checked here: `serve` refuses a
 * revoked node at hello, on every transport. A `publicKey` that throws (the server cannot answer yet) fails
 * the hello with its error, if an `RpcFailure`, rather than refusing the node. */
export interface Authentication {
  origin: string;
  publicKey(nodeId: string): Promise<string | null> | string | null;
}

/** The key lookup failed: not the node's failure, so its hello is not refused for it. */
class KeyUnavailable extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

export interface ServerTransportOptions extends LinkOptions {
  /** Per-stream buffer cap (`MAX_STREAM_BUFFER_BYTES` by default). */
  maxStreamBufferBytes?: number;
  /** Authenticate the node (`node.authenticate`) before answering its hello. Without it the connection is trusted
   * to be from whichever known node it announces, as on the permission-protected local socket. */
  authenticate?: Authentication;
  /** For a hello announcing a build (a node bundle's), once the node is authenticated and served: the build to
   * answer `update` with instead of negotiating (whatever protocol versions it offers), or null to negotiate.
   * Throwing fails the hello with that error (ADR-025). */
  offerUpdate?: (nodeId: string, buildId: string) => Promise<BuildUpdate | null>;
}

/** Server half of one node connection. Local nodes reach it over the permission-protected Unix socket
 * (`local-socket.ts`) unauthenticated; any other transport passes `authenticate`: the server then
 * challenges the node as soon as the connection is created, refuses its hello (`NODE_REFUSED`, "Not
 * authenticated") when the answer fails, and answers only a hello for the node it authenticated. A
 * refused node closes the connection; the hello timeout closes one that never says hello. `negotiated`
 * resolves once `node.hello` succeeds and rejects if the connection closes (or the hello timeout
 * expires) first. */
export function createServerTransport(socket: WireSocket, serve: ServeNode, { maxStreamBufferBytes, authenticate, offerUpdate, ...options }: ServerTransportOptions = {}) {
  let ready: { epoch: string; capabilities: Capability[] } | undefined;
  let settleNegotiation!: { resolve(value: Negotiated): void; reject(reason: Error): void };
  const negotiated = new Promise<Negotiated>((resolve, reject) => { settleNegotiation = { resolve, reject }; });
  negotiated.catch(() => undefined);
  // Streams the server opened on this connection; failed when it closes.
  const streams = createStreamRegistry(streamId => {
    if (ready?.capabilities.includes("stream.cancel")) client.notify("stream.cancel", ready.epoch, { streamId });
  }, { maxBufferedBytes: maxStreamBufferBytes });
  const peer = createRpcPeer(socket, {
    [methods.nodeHello]: {
      params: helloParams, result: helloResult,
      // In order: the node proves its key, the server will serve it, it runs the server's build (else it is
      // told to update, before versions are compared: it cannot negotiate a protocol it does not speak), and
      // it speaks this protocol version.
      async handle(hello: Hello): Promise<HelloResult> {
        if (authenticated) {
          // One answer for every failure: it must not tell whether the node ID exists.
          const nodeId = await authenticated.catch((error: unknown) => {
            if (error instanceof KeyUnavailable && error.reason instanceof RpcFailure) throw error.reason;
            throw new RpcFailure(NODE_REFUSED, "Not authenticated");
          });
          if (hello.nodeId !== nodeId) throw new RpcFailure(NODE_REFUSED, `Connection authenticated as node ${nodeId}, not ${hello.nodeId}`);
        }
        if (ready) throw new RpcFailure(UNAUTHORIZED, "Already negotiated");
        try { await serve(hello.nodeId); } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Not a refusal when the server could not answer yet (no app) or the connection closed meanwhile.
          if (!(error instanceof RpcFailure) || error.code === NODE_REFUSED) logger.warn(`Node ${hello.nodeId} refused at hello: ${message}`);
          throw error instanceof RpcFailure ? error : new RpcFailure(UNAUTHORIZED, message);
        }
        if (hello.buildId !== undefined && offerUpdate) {
          const update = await offerUpdate(hello.nodeId, hello.buildId);
          if (update) return { kind: "update", ...update };
        }
        // Another hello may have negotiated while this one waited.
        if (ready) throw new RpcFailure(UNAUTHORIZED, "Already negotiated");
        if (hello.minVersion > protocolVersion || hello.maxVersion < protocolVersion) throw new RpcFailure(NEGOTIATION_FAILED, "No common protocol version");
        const capabilities = hello.capabilities.filter((item): item is Capability => capability.safeParse(item).success);
        ready = { epoch: crypto.randomUUID(), capabilities };
        const result = { kind: "ready" as const, version: protocolVersion, epoch: ready.epoch, capabilities };
        if (helloTimer !== undefined) timers.clearTimeout(helloTimer);
        settleNegotiation.resolve({ ...result, nodeId: hello.nodeId, buildId: hello.buildId ?? null });
        return result;
      },
    },
    // Node→server methods (stream frames), served for the epoch `issued` accepts, in stream order; a bad
    // chunk fails its stream only.
    ...serveMethods(serverMethods, {
      "stream.data": input => streams.data(input),
      "stream.end": input => streams.end(input),
    }, issued),
  }, options);
  const client = methodClient(peer, nodeMethods);
  const timers = options.timers ?? systemTimers;
  const helloTimer = options.helloTimeoutMs === undefined ? undefined : timers.setTimeout(() => {
    if (!ready) { logger.warn(`Node did not negotiate within ${options.helloTimeoutMs}ms; closing the connection`); close(); }
  }, options.helloTimeoutMs);
  let closed = false;
  // Server first: one challenge per connection, consumed by the first answer whatever its outcome (the
  // peer accepts one reply per call). Resolves with the node ID the answer proved; a failure refuses the
  // hello rather than closing the connection, so the node learns it is refused and stops redialing.
  const authenticated = authenticate && authenticateNode(authenticate);
  async function authenticateNode({ origin, publicKey }: Authentication): Promise<string> {
    const challenge = newNodeChallenge();
    let nodeId: string | undefined;
    try {
      const answer = await peer.call(methods.nodeAuthenticate, challenge, authenticateResult);
      nodeId = answer.nodeId;
      let key: string | null;
      try { key = await publicKey(answer.nodeId); } catch (error) { throw new KeyUnavailable(error); }
      if (!key) throw new Error("not a paired node (unknown or unpaired)");
      if (!verifyNodeAnswer({ publicKey: key, origin, challenge, answer })) throw new Error("invalid signature");
      return answer.nodeId;
    } catch (error) {
      // Never log the challenge or the answer: only who claimed what, and why it failed.
      if (closed || error instanceof NotConnected) throw error;
      if (error instanceof KeyUnavailable) logger.warn(`Node ${nodeId}'s key could not be looked up: ${error.message}; failing its hello`);
      else logger.warn(`Node authentication failed${nodeId === undefined ? "" : ` for node ${nodeId}`}: ${error instanceof Error ? error.message : String(error)}; refusing its hello`);
      throw error;
    }
  }
  authenticated?.catch(() => undefined);
  function close() {
    closed = true;
    if (helloTimer !== undefined) timers.clearTimeout(helloTimer);
    settleNegotiation.reject(new RpcFailure("unavailable", "Connection closed before negotiation"));
    streams.close();
    peer.close();
  }
  // Node→server methods are base protocol: only the epoch this connection issued at hello is accepted.
  function issued(epoch: string): void {
    if (!ready || epoch !== ready.epoch) throw new RpcFailure(UNAUTHORIZED, "Stale or unauthorized connection");
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
    /** Opens a stream from the node (see `createStreamRegistry`): `start` sends the opening request with
     * the `streamId` allocated for it. Only a node that negotiated `stream.cancel` serves streams. */
    async openStream<T>(start: (streamId: string) => Promise<T>): Promise<NodeStream<T>> {
      authorized("stream.cancel");
      return streams.open(start);
    },
  };
}
