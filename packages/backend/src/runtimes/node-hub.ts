import { LOCAL_LINK, RpcFailure } from "@reins/node-protocol";
import type { NodeHub, NodeSocket, WsClient } from "../state.js";
import { createServerTransport } from "../node-transport/server-peer.js";
import { NodeCommandDispatcher } from "../models/node-command-dispatcher.js";
import { logger } from "../logger.js";
import type { NodeHubServices } from "./node-services.js";

export type NodeCommandClient = Pick<ReturnType<typeof createServerTransport>, "prompt" | "steer" | "setModel" | "abort" | "resumePending" | "closeSession" | "listSkills">;
/**
 * Per-call bounds (ms). Submitted work waits for the node's admission, not for the run: prompt/steer
 * may fetch attachments (each 512 KiB chunk its own 30s call), check out the task branch and open Pi over
 * the server's storage; setModel and resumePending may open the runtime. Abort waits for the aborted run
 * to go idle; close for the closed runtime. A timeout leaves the outcome unknown: submitted work is
 * requeued and its replay converges; controls fail. `skills.list` is a short read-only request a browser
 * waits for.
 */
export interface NodeCommandTimeouts { input: number; setModel: number; abort: number; resumePending: number; close: number; skills: number }
/** The open links of connected nodes, by node ID, and the per-call bounds: what the hub hands the
 * (reloadable) delivery of a command (`services.deliver`). */
export interface NodeLinks {
  link(nodeId: string): NodeCommandClient | undefined;
  readonly timeouts: NodeCommandTimeouts;
}
export const NODE_COMMAND_TIMEOUTS: NodeCommandTimeouts = { input: 120_000, setModel: 60_000, abort: 30_000, resumePending: 60_000, close: 30_000, skills: 5_000 };

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

export interface NodeHubOptions {
  /** Per-call bounds of commands sent to nodes (`NODE_COMMAND_TIMEOUTS` by default). */
  timeouts?: NodeCommandTimeouts;
  /** Sessions delivering at once (`MAX_CONCURRENT_SESSIONS` by default). */
  maxConcurrentSessions?: number;
}

interface Link { nodeId: string; socket: NodeSocket; client: NodeCommandClient }

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
 * Every node is handled alike: a session's commands go to the link of its source's node.
 */
export function createNodeHub(clients: Set<WsClient>, services: () => NodeHubServices, options: NodeHubOptions = {}): NodeHub {
  const links = new Map<string, Link>();
  let closed = false;
  const open = (nodeId: string) => {
    const link = links.get(nodeId);
    return link && !link.socket.closed ? link : undefined;
  };
  const nodeLinks: NodeLinks = { link: nodeId => open(nodeId)?.client, timeouts: options.timeouts ?? NODE_COMMAND_TIMEOUTS };
  const recipients = new SubmissionRecipients(clients);
  const dispatcher = new NodeCommandDispatcher({
    available: sessionId => {
      const nodeId = services().nodeForSession(sessionId);
      return nodeId !== null && !!open(nodeId);
    },
    send: command => services().deliver(nodeLinks, command),
    delivered: (sessionId, command, outcome) => services().delivered(recipients, sessionId, command, outcome),
  }, { maxConcurrentSessions: options.maxConcurrentSessions });

  return {
    accept(socket, linkOptions = LOCAL_LINK) {
      if (closed) { socket.close(); return; }
      const transport = createServerTransport(socket, nodeId => services().handlers(nodeId), linkOptions);
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
    connected: nodeId => !!open(nodeId),
    wake: () => dispatcher.wake(),
    send: command => services().deliver(nodeLinks, command),
    async closeSession(nodeId, sessionId) {
      const client = open(nodeId)?.client;
      if (!client) return;
      try { await client.closeSession({ sessionId }, nodeLinks.timeouts.close); }
      catch (error) { logger.warn(`Closing session ${sessionId} on node ${nodeId} failed:`, error instanceof Error ? error.message : error); }
    },
    async listSkills(nodeId, source) {
      const client = open(nodeId)?.client;
      if (!client) throw new RpcFailure("unavailable", "Node not connected");
      return (await client.listSkills(source, nodeLinks.timeouts.skills)).skills;
    },
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
