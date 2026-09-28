import { LOCAL_LINK, RpcFailure } from "@reins/node-protocol";
import type { NodeHub, NodeSocket, ProcessState, ServerState, WsClient } from "../state.js";
import { createServerTransport } from "../node-transport/server-peer.js";
import { NODE_COMMAND_TIMEOUTS, type NodeCommandClient, type NodeCommandTimeouts, type NodeLinks } from "../node-transport/commands.js";
import { clearSessionDeletion, getNode, pendingSessionDeletions } from "../node-store.js";
import { NodeCommandDispatcher } from "../models/node-command-dispatcher.js";
import { onCommandDelivered, SubmissionRecipients } from "../models/node-command-notifications.js";
import { logger } from "../logger.js";
import { nodeServerHandlers, type NodeServerServices } from "./node-server-handlers.js";
import { deliverToNode } from "./node-execution.js";
import { nodeSessionReports } from "./node-session-events.js";
import { nodeToolCalls } from "./node-tool-calls.js";
import { createNodeCredentialService } from "./node-credentials.js";

export interface NodeHubOptions {
  /** Per-call bounds of commands sent to nodes (`NODE_COMMAND_TIMEOUTS` by default). */
  timeouts?: NodeCommandTimeouts;
  /** Sessions delivering at once (`MAX_CONCURRENT_SESSIONS` by default). */
  maxConcurrentSessions?: number;
}

interface Link { nodeId: string; socket: NodeSocket; client: NodeCommandClient }

/**
 * The node hub of one handler install (see `NodeHub`). The server never starts a node: nodes dial in
 * (the local node over the process owner's Unix socket listener) and announce their node ID in
 * `node.hello`. A connection is served only for a node ID with a `nodes` row (unknown IDs are refused at
 * hello; enrolling and authenticating remote nodes is future work, the local socket's file permissions
 * are the local authorization). Once it negotiates it becomes that node's only link: the node's previous
 * link is closed, so its in-flight calls fail with outcome unknown (submitted work requeues) and anything
 * the old connection still sends carries an epoch the new one never issued (`-32003`); queued work is
 * woken. A connection that never negotiates is closed by the hello timeout and never replaces a link.
 * Every node is handled alike: a session's commands go to the link of its source's node.
 */
export function createNodeHub(clients: Set<WsClient>, services: () => NodeServerServices, options: NodeHubOptions = {}): NodeHub {
  const links = new Map<string, Link>();
  let closed = false;
  const open = (nodeId: string) => {
    const link = links.get(nodeId);
    return link && !link.socket.closed ? link : undefined;
  };
  const nodeLinks: NodeLinks = { link: nodeId => open(nodeId)?.client, timeouts: options.timeouts ?? NODE_COMMAND_TIMEOUTS };
  /** Node ID → its running `session.delete` pass. */
  const deleting = new Map<string, Promise<void>>();
  /** Tells a connected node to drop the sessions deleted on the server (`node_session_deletions`), one at
   * a time, clearing each once acknowledged; stops at the first failure (retried on the next wake or
   * connection). One pass per node at a time; a pass re-reads until nothing is left. */
  const deleteSessionsOn = (nodeId: string): Promise<void> => {
    const running = deleting.get(nodeId);
    if (running) return running;
    const pass = (async () => {
      for (let pending = pendingSessionDeletions(nodeId); pending.length; pending = pendingSessionDeletions(nodeId)) {
        for (const sessionId of pending) {
          const client = open(nodeId)?.client;
          if (!client || closed) return;
          try { await client.delete({ sessionId }, nodeLinks.timeouts.delete); }
          catch (error) { logger.warn(`Deleting session ${sessionId} on node ${nodeId} failed:`, error instanceof Error ? error.message : error); return; }
          clearSessionDeletion(sessionId, nodeId);
        }
      }
    })().finally(() => deleting.delete(nodeId));
    deleting.set(nodeId, pass);
    return pass;
  };
  /** Wakes the dispatcher and the deletion passes of every connected node. */
  const wake = async () => {
    await Promise.all([dispatcher.wake(), ...[...links.keys()].filter(nodeId => open(nodeId)).map(deleteSessionsOn)]);
  };
  const recipients = new SubmissionRecipients(clients);
  const dispatcher = new NodeCommandDispatcher({
    connected: nodeId => !!open(nodeId),
    send: command => deliverToNode(nodeLinks, command),
    delivered: (sessionId, command, outcome) => onCommandDelivered(clients, recipients, sessionId, command, outcome),
  }, { maxConcurrentSessions: options.maxConcurrentSessions });

  return {
    accept(socket, linkOptions = LOCAL_LINK) {
      if (closed) { socket.close(); return; }
      const transport = createServerTransport(socket, nodeId => {
        if (!getNode(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
        return nodeServerHandlers(nodeId, services());
      }, linkOptions);
      let link: Link | undefined;
      socket.onmessage = transport.receive;
      socket.onclose = () => {
        transport.close();
        if (link && links.get(link.nodeId) === link) {
          links.delete(link.nodeId);
          logger.info(`Node ${link.nodeId} disconnected`);
        }
      };
      transport.negotiated.then(({ nodeId }) => {
        if (socket.closed) return;
        if (closed) { socket.close(); return; }
        link = { nodeId, socket, client: transport };
        const previous = links.get(nodeId);
        links.set(nodeId, link);
        previous?.socket.close();
        logger.info(`Node ${nodeId} connected`);
        void dispatcher.wake();
        void deleteSessionsOn(nodeId);
      }, () => undefined);
    },
    connected: nodeId => !!open(nodeId),
    wake,
    send: command => deliverToNode(nodeLinks, command),
    async listSkills(nodeId, source) {
      const client = open(nodeId)?.client;
      if (!client) throw new RpcFailure("unavailable", "Node not connected");
      return (await client.listSkills(source, nodeLinks.timeouts.skills)).skills;
    },
    commandSettled(commandId) {
      const settled = dispatcher.wait(commandId);
      void dispatcher.wake();
      return settled;
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

/** The product services node→server calls reach. */
export function nodeServerServices(state: ServerState): NodeServerServices {
  return { ...nodeSessionReports(state), ...nodeToolCalls(state), ...createNodeCredentialService() };
}

/** Gives `process` a new node hub (`state.nodes`), replacing the previous handler's; the caller starts
 * it and closes it on uninstall. The product services are built on the first node connection. */
export function installNodeHub(process: ProcessState, options: NodeHubOptions = {}): ServerState {
  let services: NodeServerServices | undefined;
  const state: ServerState = Object.assign(process, { nodes: createNodeHub(process.clients, () => services ??= nodeServerServices(state), options) });
  return state;
}
