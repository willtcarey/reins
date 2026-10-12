/**
 * The process's node hub (see `NodeHub`; ADR-029). Process-owned: created once by `createServerProcess`
 * (`process-state.ts`), kept across reloads of the app, restart-only. It imports only the protocol, other
 * process-owned modules and types: what it needs of product code it asks the current app at each use
 * (`App.hub`, through `ServerProcess.app`), so a hello arriving while no app is current waits for the next.
 */
import { LOCAL_LINK, NEGOTIATION_FAILED, NODE_REFUSED, RpcFailure, type BuildUpdate, type MethodCallOptions, type MethodInput, type nodeMethods } from "@reins/node-protocol";
import type { App, NodeBuild, NodeHub, NodeSocket, RemoteNode, StreamMethod } from "../state.js";
import { createServerTransport } from "./server-peer.js";
import { logger } from "../logger.js";

/** Bound on a node accepting a `process.run` (spawning it), not on the process. */
export const PROCESS_START_TIMEOUT_MS = 10_000;

export interface NodeHubOptions {
  /** Per-stream buffer cap (`MAX_STREAM_BUFFER_BYTES` by default). */
  maxStreamBufferBytes?: number;
}

interface Link { nodeId: string; socket: NodeSocket; client: ReturnType<typeof createServerTransport> }

/**
 * The server never starts a node: nodes dial in (the local node over the process's Unix socket listener,
 * remote ones over `/nodes/link`) and announce their node ID in `node.hello`. A connection is served only
 * for a node the current app serves (`HubApp.refusal`: a known node, neither removed nor revoked; others are
 * refused at hello, on every transport). The transport that accepted it decides whether it must first
 * prove that ID: the local socket's file permissions are its authorization, so its connections are not
 * challenged; a connection accepted with `authenticate` is challenged (`node.authenticate`) and must sign it
 * with the key the node was paired with (`HubApp.publicKey`: none for an unknown or unpaired node) before
 * its hello, which must be as that node, is answered. Once it negotiates it becomes that node's only link:
 * the node's previous link is closed, so its in-flight calls fail with outcome unknown (a session's tool
 * calls send them again, or pick their command up again, on the new one) and anything the old connection
 * still sends carries an epoch the new one never issued (`-32003`). A connection that never negotiates is
 * closed by the hello timeout and never replaces a link. A node bundle's hello announces its build: the
 * current app answers it against its own (`HubApp.helloBuild`, ADR-025), and one told to update is not
 * served; the build each node announced is kept in memory for its view (`RemoteNode.build`). Browsers are
 * told when a node gets a link, when it loses its link and when a node is told to update
 * (`HubApp.publish`), not when one link replaces another. Every node is handled alike.
 *
 * `app` is the process's current app (`ServerProcess.app`): waited for during a reload's gap, until
 * `signal` (the connection closing) aborts. A reload of the app changes nothing here: links stay open.
 */
export function createNodeHub(app: (signal?: AbortSignal) => Promise<App>, options: NodeHubOptions = {}): NodeHub {
  const links = new Map<string, Link>();
  let closed = false;
  const open = (nodeId: string) => {
    const link = links.get(nodeId);
    return link && !link.socket.closed ? link : undefined;
  };
  // The build each node bundle announced at its latest hello, while it is linked or was told to update.
  const builds = new Map<string, NodeBuild>();
  /** The current app for a hello's step: one that does not come in time fails the hello, to be retried. */
  const current = async (signal: AbortSignal) => {
    try { return await app(signal); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new RpcFailure(NEGOTIATION_FAILED, `The server is not ready: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /** Tells browsers through the current app, once there is one. */
  const publish = (nodeId: string) => {
    app().then(
      answering => answering.hub.publish(nodeId),
      (error: unknown) => logger.warn(`Telling browsers about node ${nodeId} failed:`, error instanceof Error ? error.message : error),
    );
  };
  /** The node's open link for one call. */
  const linked = (nodeId: string) => {
    const client = open(nodeId)?.client;
    if (!client) throw new RpcFailure("unavailable", "Node not connected");
    return client;
  };
  const remoteNode = (nodeId: string): RemoteNode => {
    const node: RemoteNode = {
      id: nodeId,
      get connected() { return !!open(nodeId); },
      get build() { return builds.get(nodeId) ?? null; },
      async request(method, input, callOptions) { return linked(nodeId).call(method, input, callOptions); },
      async openStream<M extends StreamMethod>(method: M, input: Omit<MethodInput<(typeof nodeMethods)[M]>, "streamId">, callOptions?: MethodCallOptions) {
        const client = linked(nodeId);
        // The spread restores exactly the field `input` omits, which a generic `Omit` cannot show.
        return client.openStream(streamId => client.call(method, { ...input, streamId } as MethodInput<(typeof nodeMethods)[M]>, callOptions)); // eslint-disable-line typescript-eslint/consistent-type-assertions -- see above
      },
      async spawn(argv, { sourceId, cwd, env, binary }) {
        const input = { sourceId, cwd, argv, ...(env ? { env } : {}), ...(binary ? { binary } : {}) };
        const { body, ended } = await node.openStream("process.run", input, { timeoutMs: PROCESS_START_TIMEOUT_MS });
        const exited = ended.then(exit => exit ?? Promise.reject(new Error(`Process stream ended without an exit: ${argv[0]}`)));
        // A consumer that cancels stdout need not await the exit.
        exited.catch(() => undefined);
        return { stdout: body, exited };
      },
    };
    return node;
  };
  const hub: NodeHub = {
    accept(socket, { authenticate, ...linkOptions } = LOCAL_LINK) {
      if (closed) { socket.close(); return; }
      // Ends any wait for an app when the connection closes.
      const closing = new AbortController();
      // How this connection's build was judged at its hello, for its view once it negotiates.
      let served: NodeBuild["status"] | undefined;
      /** Refuses the hello of a node the current app does not serve with `NODE_REFUSED` and its reason,
       * which stops the node redialing. */
      const serveNode = async (nodeId: string) => {
        const refusal = (await current(closing.signal)).hub.refusal(nodeId);
        if (refusal !== null) throw new RpcFailure(NODE_REFUSED, refusal);
      };
      /** The rule for a node bundle's hello (ADR-025), once the node is authenticated and served: the current
       * app's answer, recorded (a node told to update is shown updating). */
      const offerUpdate = async (nodeId: string, buildId: string): Promise<BuildUpdate | null> => {
        const answering = await current(closing.signal);
        const answer = await answering.hub.helloBuild(nodeId, buildId);
        if (answer.kind === "not_ready") throw new RpcFailure(NEGOTIATION_FAILED, answer.message);
        if (answer.kind === "serve") { served = answer.status; return null; }
        builds.set(nodeId, { id: buildId, status: "updating" });
        answering.hub.publish(nodeId);
        return answer.update;
      };
      const transport = createServerTransport(socket, serveNode, {
        ...linkOptions, maxStreamBufferBytes: options.maxStreamBufferBytes,
        ...(authenticate ? { authenticate: { origin: authenticate.origin, publicKey: async (nodeId: string) => (await current(closing.signal)).hub.publicKey(nodeId) } } : {}),
        offerUpdate,
      });
      let link: Link | undefined;
      socket.onmessage = transport.receive;
      socket.onclose = () => {
        closing.abort(new RpcFailure("unavailable", "Connection closed"));
        transport.close();
        if (link && links.get(link.nodeId) === link) {
          links.delete(link.nodeId);
          builds.delete(link.nodeId);
          logger.info(`Node ${link.nodeId} disconnected`);
          if (!closed) publish(link.nodeId);
        }
      };
      transport.negotiated.then(({ nodeId, buildId }) => {
        if (socket.closed) return;
        if (closed) { socket.close(); return; }
        link = { nodeId, socket, client: transport };
        const previous = links.get(nodeId);
        links.set(nodeId, link);
        previous?.socket.close();
        const updated = builds.get(nodeId)?.status === "updating";
        if (buildId === null) builds.delete(nodeId);
        else builds.set(nodeId, { id: buildId, status: served ?? "outdated" });
        logger.info(`Node ${nodeId} connected${buildId === null ? "" : ` (build ${buildId.slice(0, 12)})`}`);
        if (!previous || updated) publish(nodeId);
      }, () => undefined);
    },
    get: remoteNode,
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
