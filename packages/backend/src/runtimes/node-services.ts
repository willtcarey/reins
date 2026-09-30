import type { ServerState } from "../state.js";
import { getSession } from "../session-store.js";
import { getNode } from "../node-store.js";
import type { ServerHandlers } from "../node-transport/server-peer.js";
import { resolveSessionSource } from "./node-source.js";
import { deliverToNode } from "../node-transport/commands.js";
import { nodeSessionReports } from "./node-session-events.js";
import { sessionRuns } from "./session-runs.js";
import { createBroadcast } from "../models/broadcast.js";
import { nodeToolCalls } from "./node-tool-calls.js";
import { createNodeCredentialService } from "./node-credentials.js";
import { nodeServerHandlers, type NodeServerServices } from "./node-server-handlers.js";
import { onCommandDelivered } from "../models/node-command-notifications.js";
import type { SubmissionRecipients } from "./node-hub.js";
import type { DispatchTarget } from "../models/node-command-dispatcher.js";

export interface NodeHubServices extends NodeServerServices {
  handlers(nodeId: string): ServerHandlers;
  recover(nodeId: string, liveSessions: readonly string[]): void;
  nodeForSession(sessionId: string): string | null;
  deliver: typeof deliverToNode;
  /** After a command settled (`onCommandDelivered`); the hub owns who submitted which input. */
  delivered(recipients: SubmissionRecipients, ...settled: Parameters<DispatchTarget["delivered"]>): void;
}

/** Replaceable product handlers. The process-owned hub captures these once per call, not per link. */
export function nodeServerServices(state: ServerState): NodeHubServices {
  const services: NodeHubServices = {
    ...nodeSessionReports(state), ...nodeToolCalls(state), ...createNodeCredentialService(),
    nodeForSession(sessionId) {
      const session = getSession(sessionId);
      return session ? resolveSessionSource(session)?.nodeId ?? null : null;
    },
    deliver: deliverToNode,
    delivered: (recipients, ...settled) => onCommandDelivered(state.clients, recipients, ...settled),
    handlers(nodeId) {
      if (!getNode(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
      return nodeServerHandlers(nodeId, services);
    },
    recover: (nodeId, liveSessions) => sessionRuns({ broadcast: createBroadcast(state.clients), nodes: state.nodes }).settleInterruptedRuns(nodeId, liveSessions),
  };
  return services;
}
