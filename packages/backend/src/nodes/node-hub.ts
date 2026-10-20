import { LOCAL_LINK, NEGOTIATION_FAILED, NODE_REFUSED, RpcFailure, type BuildUpdate, type MethodCallOptions, type MethodInput, type NodeDocs, type nodeMethods } from "@reins/node-protocol";
import type { AppState, NodeBuild, NodeFailure, NodeHub, NodeSocket, NodeClient, StreamMethod } from "../state.js";
import { createServerTransport } from "./server-peer.js";
import { logger } from "../logger.js";
import { NodeNotFoundError } from "../models/nodes.js";
import { NodeRemovedError, NodeRevokedError } from "../models/node.js";
import { Models } from "../models/models.js";

/** How long a node bundle's hello waits for this app's node build (it builds in the background as the app
 * starts) before failing, to be retried: well under the hello timeout. */
export const HELLO_BUILD_WAIT_MS = 5_000;

export interface NodeHubOptions {
  /** Per-stream buffer cap (`MAX_STREAM_BUFFER_BYTES` by default). */
  maxStreamBufferBytes?: number;
  /** `HELLO_BUILD_WAIT_MS` by default. */
  buildWaitMs?: number;
}

interface Link { nodeId: string; socket: NodeSocket; client: ReturnType<typeof createServerTransport>; docs: NodeDocs }

/**
 * The node hub of one app (see `NodeHub`). The server never starts a node: nodes dial in
 * (the local node over the app's Unix socket listener) and announce their node ID in
 * `node.hello`. A connection is served only for a known node ID neither removed nor revoked (a `nodes` row; others are
 * refused at hello, on every transport: `serveNode`). The transport that accepted it decides whether it
 * must first prove that ID: the local socket's file permissions are its authorization, so its connections
 * are not challenged; a connection accepted with `authenticate` is challenged (`node.authenticate`) and
 * must sign it with the key the node was paired with (`NodeModel.publicKey`: none for an unknown or
 * unpaired node) before its hello, which must be as that node, is answered. Once it negotiates it becomes that node's only link: the node's previous
 * link is closed, so its in-flight calls fail with outcome unknown (a session's tool calls send them
 * again, or pick their command up again, on the new one) and its streams fail: a stream belongs to the
 * connection that opened it. A connection that never negotiates is
 * closed by the hello timeout and never replaces a link. A node bundle's hello announces its build: one other than this
 * app's is answered `update` instead of being served (`offerUpdate`, ADR-025), and the build each node
 * announced is kept in memory for its view (`NodeClient.build`). Browsers are told when a node gets a link,
 * when it loses its link and when a node is told to update
 * (`Nodes.publish`), not when one link replaces another. Every node is handled alike.
 *
 * `state` is the app's state this hub belongs to (its models and node build), read once the hub is in
 * use, since the state is built around the hub. A dev reload closes the hub and builds a new one;
 * its nodes redial (docs/dev/hot-reload.md).
 */
export function createNodeHub(state: () => AppState, options: NodeHubOptions = {}): NodeHub {
  const links = new Map<string, Link>();
  let closed = false;
  const open = (nodeId: string) => {
    const link = links.get(nodeId);
    return link && !link.socket.closed ? link : undefined;
  };
  // The build each node bundle announced at its latest hello, while it is linked or was told to update.
  const builds = new Map<string, NodeBuild>();
  // Why each node's latest hello did not negotiate, until it next connects: nothing else tells a node that
  // keeps redialing from one that is off.
  const failures = new Map<string, NodeFailure>();
  /** Records, logs and tells browsers why `nodeId` could not negotiate, when that is new: it redials every few seconds. */
  const negotiationFailed = (nodeId: string, message: string) => {
    if (failures.get(nodeId)?.message === message) return;
    failures.set(nodeId, { message, at: new Date().toISOString() });
    logger.warn(`Node ${nodeId} cannot negotiate: ${message}`);
    models().nodes.publish(nodeId);
  };
  // This app's build ID once a hello has waited for it (null: its build failed).
  let serverBuildId: string | null | undefined;
  // The hub's models, built once it is in use (the state is built around the hub).
  let built: Models | undefined;
  const models = () => built ??= new Models(state());
  /** The key a connection authenticating as node `nodeId` must prove it holds: none for an unknown or
   * unpaired node. A revoked or removed node holds its key and is refused at hello. */
  const publicKey = (nodeId: string) => {
    try {
      return models().nodes.get(nodeId).publicKey;
    } catch (error) {
      if (error instanceof NodeNotFoundError) return null;
      throw error;
    }
  };
  /** Refuses the hello of an unknown node (`NodeNotFoundError`), a removed one (`NodeRemovedError`) or a
   * revoked one (`NodeRevokedError`) with `NODE_REFUSED` and its message, on every connection whatever its
   * transport, which stops the node redialing. */
  const serveNode = (nodeId: string) => {
    try {
      models().nodes.get(nodeId).assertMayConnect();
    } catch (error) {
      if (error instanceof NodeNotFoundError || error instanceof NodeRemovedError || error instanceof NodeRevokedError) throw new RpcFailure(NODE_REFUSED, error.message);
      throw error;
    }
  };
  /** The node's open link for one call. */
  const linked = (nodeId: string) => {
    const client = open(nodeId)?.client;
    if (!client) throw new RpcFailure("unavailable", "Node not connected");
    return client;
  };
  /**
   * The rule for a node bundle's hello (ADR-025), once the node is authenticated and served: one announcing
   * another build than this app's is told to update to this app's, and recorded as updating; one announcing
   * this app's build negotiates. While the build is still running the hello waits for it, at most
   * `buildWaitMs`, then fails (the node redials). Without a build (it failed) the node negotiates as it is.
   */
  const offerUpdate = async (nodeId: string, buildId: string): Promise<BuildUpdate | null> => {
    const build = await state().nodeBundle.build(options.buildWaitMs ?? HELLO_BUILD_WAIT_MS);
    if (build === "building") throw new RpcFailure(NEGOTIATION_FAILED, "The server's node build is not ready yet");
    serverBuildId = build?.buildId ?? null;
    if (!build) {
      logger.warn(`Node ${nodeId} runs build ${buildId.slice(0, 12)}, and this server has no node build to offer (its build failed); serving it as it is`);
      return null;
    }
    if (build.buildId === buildId) return null;
    logger.info(`Node ${nodeId} runs build ${buildId.slice(0, 12)}; telling it to update to ${build.buildId.slice(0, 12)}`);
    builds.set(nodeId, { id: buildId, status: "updating" });
    models().nodes.publish(nodeId);
    return { buildId: build.buildId, sha256: build.sha256, bunVersion: build.bunVersion };
  };
  const nodeClient = (nodeId: string): NodeClient => ({
    id: nodeId,
    get connected() { return !!open(nodeId); },
    get build() { return builds.get(nodeId) ?? null; },
    get failure() { return failures.get(nodeId) ?? null; },
    get docs() { return open(nodeId)?.docs ?? null; },
    async request(method, input, callOptions) { return linked(nodeId).call(method, input, callOptions); },
    async openStream<M extends StreamMethod>(method: M, input: Omit<MethodInput<(typeof nodeMethods)[M]>, "streamId">, callOptions?: MethodCallOptions) {
      const client = linked(nodeId);
      // The spread restores exactly the field `input` omits, which a generic `Omit` cannot show.
      return client.openStream(streamId => client.call(method, { ...input, streamId } as MethodInput<(typeof nodeMethods)[M]>, callOptions)); // eslint-disable-line typescript-eslint/consistent-type-assertions -- see above
    },
  });
  const hub: NodeHub = {
    accept(socket, { authenticate, ...linkOptions } = LOCAL_LINK) {
      if (closed) { socket.close(); return; }
      const transport = createServerTransport(socket, serveNode, {
        ...linkOptions, maxStreamBufferBytes: options.maxStreamBufferBytes,
        ...(authenticate ? { authenticate: { origin: authenticate.origin, publicKey } } : {}),
        offerUpdate,
        onNegotiationFailed: negotiationFailed,
      });
      let link: Link | undefined;
      socket.onmessage = transport.receive;
      socket.onclose = () => {
        transport.close();
        if (link && links.get(link.nodeId) === link) {
          links.delete(link.nodeId);
          builds.delete(link.nodeId);
          logger.info(`Node ${link.nodeId} disconnected`);
          models().nodes.publish(link.nodeId);
        }
      };
      transport.negotiated.then(({ nodeId, buildId, docs }) => {
        if (socket.closed) return;
        if (closed) { socket.close(); return; }
        link = { nodeId, socket, client: transport, docs };
        const previous = links.get(nodeId);
        links.set(nodeId, link);
        previous?.socket.close();
        const updated = builds.get(nodeId)?.status === "updating";
        failures.delete(nodeId);
        if (buildId === null) builds.delete(nodeId);
        else builds.set(nodeId, { id: buildId, status: buildId === serverBuildId ? "current" : "outdated" });
        logger.info(`Node ${nodeId} connected${buildId === null ? "" : ` (build ${buildId.slice(0, 12)})`}`);
        if (!previous || updated) models().nodes.publish(nodeId);
      }, () => undefined);
    },
    get: nodeClient,
    disconnect(nodeId) { links.get(nodeId)?.socket.close(); },
    async close() {
      closed = true;
      // Calls in flight on these links end now (outcome unknown).
      for (const link of links.values()) link.socket.close();
      links.clear();
    },
  };
  return hub;
}
