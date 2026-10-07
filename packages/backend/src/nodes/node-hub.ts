import { LOCAL_LINK, RpcFailure, type MethodCallOptions, type MethodInput, type nodeMethods, type NodeCommand, type NodeResult } from "@reins/node-protocol";
import type { NodeHub, NodeSocket, RemoteNode, ServerState, StreamMethod } from "../state.js";
import { createServerTransport, type ServerHandlers } from "./server-peer.js";
import { NodeCommandDispatcher } from "./node-command-dispatcher.js";
import { nodeHandlers } from "./node-handlers.js";
import { sessionRoute } from "./commands.js";
import { onCommandDelivered } from "./node-command-notifications.js";
import { createBroadcast } from "../models/broadcast.js";
import { createResumeBudget, sessionRuns } from "../sessions/session-runs.js";
import { logger } from "../logger.js";

/**
 * Per-call bounds (ms) of delivering outbox commands. They wait for the node's admission, not for the
 * run: prompt/steer may fetch attachments (each 512 KiB chunk its own 30s call), check out the task
 * branch and open Pi over the server's storage; setModel may open the runtime. A timeout leaves the
 * outcome unknown: the command is requeued and its replay converges.
 */
export interface NodeCommandTimeouts { input: number; setModel: number }
export const NODE_COMMAND_TIMEOUTS: NodeCommandTimeouts = { input: 120_000, setModel: 60_000 };
/** Bound on a node accepting a `process.run` (spawning it), not on the process. */
export const PROCESS_START_TIMEOUT_MS = 10_000;

/** A session resolved to its source's node (`sessionRoute`). */
export interface SessionRoute {
  readonly nodeId: string;
  /** Delivers one of the session's outbox commands to that node, bounded by `timeouts`; throws
   * `DeliveryDeferred` when the node did not run it or the outcome is unknown (the outbox requeues it). */
  send(node: RemoteNode, command: NodeCommand, timeouts: NodeCommandTimeouts): Promise<NodeResult>;
}

export interface NodeHubOptions {
  /** Per-call bounds of delivering outbox commands (`NODE_COMMAND_TIMEOUTS` by default). */
  timeouts?: NodeCommandTimeouts;
  /** Sessions delivering at once (`MAX_CONCURRENT_SESSIONS` by default). */
  maxConcurrentSessions?: number;
  /** Per-stream buffer cap (`MAX_STREAM_BUFFER_BYTES` by default). */
  maxStreamBufferBytes?: number;
}

interface Link { nodeId: string; socket: NodeSocket; client: ReturnType<typeof createServerTransport> }

/**
 * The node hub of one handler load (see `NodeHub`). The server never starts a node: nodes dial in
 * (the local node over the load's Unix socket listener) and announce their node ID in
 * `node.hello`. A connection is served only for a node ID with a `nodes` row (unknown IDs are refused at
 * hello; enrolling and authenticating remote nodes is future work, the local socket's file permissions
 * are the local authorization). Once it negotiates it becomes that node's only link: the node's previous
 * link is closed, so its in-flight calls fail with outcome unknown (submitted work requeues) and anything
 * the old connection still sends carries an epoch the new one never issued (`-32003`). Every run the
 * server still sees running on that node and the hello does not list as live was lost by the node (it
 * holds nothing that could report it later): it is resumed on the node, or settled as interrupted
 * (`recoverLostRuns`, ADR-021); meanwhile queued work is woken. A connection that never negotiates is
 * closed by the hello timeout and never replaces a link.
 * Every node is handled alike: a session's outbox commands go to the link of its source's node.
 *
 * `state` is the server state this hub belongs to (its product code needs it), read once the hub is in
 * use, since the state is built around the hub. A dev handler reload closes the hub and builds a new one;
 * its nodes redial (docs/dev/hot-reload.md).
 */
export function createNodeHub(state: () => ServerState, options: NodeHubOptions = {}): NodeHub {
  let handlers: ((nodeId: string) => ServerHandlers) | undefined;
  const links = new Map<string, Link>();
  // Automatic resumes per session, against a run that crashes its node every time.
  const resumes = createResumeBudget();
  let closed = false;
  const open = (nodeId: string) => {
    const link = links.get(nodeId);
    return link && !link.socket.closed ? link : undefined;
  };
  const timeouts = options.timeouts ?? NODE_COMMAND_TIMEOUTS;
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
  const dispatcher = new NodeCommandDispatcher({
    route: sessionId => {
      const route = sessionRoute(sessionId);
      if (!route) return null;
      const node = remoteNode(route.nodeId);
      return node.connected ? command => route.send(node, command, timeouts) : null;
    },
    delivered: (sessionId, command, outcome) => onCommandDelivered(state().clients, sessionId, command, outcome),
  }, { maxConcurrentSessions: options.maxConcurrentSessions });

  return {
    accept(socket, linkOptions = LOCAL_LINK) {
      if (closed) { socket.close(); return; }
      const transport = createServerTransport(socket, nodeId => (handlers ??= nodeHandlers(state()))(nodeId), { ...linkOptions, maxStreamBufferBytes: options.maxStreamBufferBytes });
      let link: Link | undefined;
      socket.onmessage = transport.receive;
      socket.onclose = () => {
        transport.close();
        if (link && links.get(link.nodeId) === link) {
          links.delete(link.nodeId);
          logger.info(`Node ${link.nodeId} disconnected`);
        }
      };
      transport.negotiated.then(({ nodeId, liveSessions }) => {
        if (socket.closed) return;
        if (closed) { socket.close(); return; }
        link = { nodeId, socket, client: transport };
        const previous = links.get(nodeId);
        links.set(nodeId, link);
        previous?.socket.close();
        logger.info(`Node ${nodeId} connected`);
        // The node holds nothing that could report a run it lost: resume it (ADR-021).
        sessionRuns({ broadcast: createBroadcast(state().clients), nodes: state().nodes }).recoverLostRuns(nodeId, liveSessions, resumes)
          .catch((error: unknown) => logger.error(`Recovering lost runs on node ${nodeId} failed:`, error));
        void dispatcher.wake();
      }, () => undefined);
    },
    get: remoteNode,
    credentialsChanged(providerId) {
      for (const nodeId of links.keys()) open(nodeId)?.client.notify("credentials.changed", { providerId });
    },
    wake: () => dispatcher.wake(),
    start: () => dispatcher.start(),
    close() {
      closed = true;
      const settled = dispatcher.stop();
      // Calls in flight on these links end now (outcome unknown), so their deliveries settle promptly.
      for (const link of links.values()) link.socket.close();
      links.clear();
      return settled;
    },
  };
}
