import { LOCAL_LINK, RpcFailure, type MethodCallOptions, type MethodInput, type nodeMethods, type NodeCommand, type NodeResult } from "@reins/node-protocol";
import type { NodeHub, NodeSocket, RemoteNode, StreamMethod, WsClient } from "../state.js";
import { createServerTransport, type ServerHandlers } from "./server-peer.js";
import { NodeCommandDispatcher, type DispatchTarget } from "./node-command-dispatcher.js";
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

const recipientKey = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

/** The browser clients that submitted inputs, so an input's failure reaches its submitter. A delivery
 * hint, not durable state: a failure is notified once, then its command is deleted. */
export class SubmissionRecipients {
  private readonly recipients = new Map<string, WsClient>();
  constructor(private readonly clients: Set<WsClient>) {}

  observe(sessionId: string, clientId: string, client: WsClient): void {
    this.recipients.set(recipientKey(sessionId, clientId), client);
  }

  forget(client: WsClient): void {
    for (const [id, target] of this.recipients) if (target === client) this.recipients.delete(id);
  }

  notifyFailure(sessionId: string, clientId: string, error: string): void {
    const client = this.recipients.get(recipientKey(sessionId, clientId));
    if (!client || !this.clients.has(client)) return;
    try { client.ws.send(JSON.stringify({ type: "error", sessionId, clientId, error })); } catch { /* disconnected */ }
  }
}

/**
 * The hub's port into product code (`nodes/node-services.ts`). Product code hot reloads: the hub asks
 * `server-process.ts` for the current services on every call, and nothing it holds outlives the call.
 */
export interface NodeHubServices {
  /** Serves the calls of node `nodeId` (the ID its hello announced); throws to refuse the node. */
  handlers(nodeId: string): ServerHandlers;
  /** Once node `nodeId` negotiated: settles as interrupted every run the server sees on it that the hello
   * did not list as live. */
  recover(nodeId: string, liveSessions: readonly string[]): void;
  /** Where the session's outbox commands go now (its source's node), or null when the session or its
   * source is gone. Resolved once per delivery: the hub checks that node is connected and sends through
   * the route. */
  route(sessionId: string): SessionRoute | null;
  /** After a command settled; the hub keeps who submitted which input. */
  delivered(recipients: SubmissionRecipients, ...settled: Parameters<DispatchTarget["delivered"]>): void;
}

/** A session resolved to its source's node. */
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
 * The node hub of one server process (see `NodeHub`). The server never starts a node: nodes dial in
 * (the local node over the process owner's Unix socket listener) and announce their node ID in
 * `node.hello`. A connection is served only for a node ID with a `nodes` row (unknown IDs are refused at
 * hello; enrolling and authenticating remote nodes is future work, the local socket's file permissions
 * are the local authorization). Once it negotiates it becomes that node's only link: the node's previous
 * link is closed, so its in-flight calls fail with outcome unknown (submitted work requeues) and anything
 * the old connection still sends carries an epoch the new one never issued (`-32003`). Every run the
 * server still sees running on that node and the hello does not list as live is settled as interrupted
 * (crash recovery: the node holds nothing that could report it later); then queued work is woken. A
 * connection that never negotiates is closed by the hello timeout and never replaces a link.
 * Every node is handled alike: a session's outbox commands go to the link of its source's node.
 */
export function createNodeHub(clients: Set<WsClient>, services: () => NodeHubServices, options: NodeHubOptions = {}): NodeHub {
  const links = new Map<string, Link>();
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
  const recipients = new SubmissionRecipients(clients);
  const dispatcher = new NodeCommandDispatcher({
    route: sessionId => {
      const route = services().route(sessionId);
      if (!route) return null;
      const node = remoteNode(route.nodeId);
      return node.connected ? command => route.send(node, command, timeouts) : null;
    },
    delivered: (sessionId, command, outcome) => services().delivered(recipients, sessionId, command, outcome),
  }, { maxConcurrentSessions: options.maxConcurrentSessions });

  return {
    accept(socket, linkOptions = LOCAL_LINK) {
      if (closed) { socket.close(); return; }
      const transport = createServerTransport(socket, nodeId => services().handlers(nodeId), { ...linkOptions, maxStreamBufferBytes: options.maxStreamBufferBytes });
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
        try { services().recover(nodeId, liveSessions); }
        catch (error) { logger.error(`Settling interrupted runs on node ${nodeId} failed:`, error); }
        void dispatcher.wake();
      }, () => undefined);
    },
    get: remoteNode,
    wake: () => dispatcher.wake(),
    observeSubmission: (sessionId, clientId, client) => recipients.observe(sessionId, clientId, client),
    forgetClient: client => recipients.forget(client),
    start: () => dispatcher.start(),
    close() {
      closed = true;
      dispatcher.stop();
      for (const link of links.values()) link.socket.close();
      links.clear();
    },
  };
}
