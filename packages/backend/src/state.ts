/**
 * Server State (shared types)
 *
 * Type definitions for the long-lived state that survives hot reloads.
 * The actual state objects are owned by server-process.ts; handler.ts and ws.ts
 * receive them as parameters. The server holds no session runtimes: sessions run on nodes.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

import type { NodeCommand, NodeResult, LinkOptions, SkillInfo, SkillsList, WireSocket } from "@reins/node-protocol";

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

export interface WsClient {
  ws: WebSocketLike;
}

/** A node connection as the process owner's listener accepts it: an NDJSON Unix socket in production,
 * an in-memory socket in tests. */
export type NodeSocket = WireSocket & { onmessage?: (data: string) => void; onclose?: () => void; readonly closed: boolean };

/**
 * The process-owned node hub (`runtimes/node-hub.ts`): the negotiated
 * connection of every connected node (by the node ID it announced), the node→server services, the
 * command dispatcher and submission failure recipients. No node is special: a session's commands go to
 * the node of its source.
 */
export interface NodeHub {
  /** Serves one node connection; once it negotiates `node.hello` for a known node ID it is that node's link. */
  accept(socket: NodeSocket, options?: LinkOptions): void;
  /** Whether a negotiated connection of the node is open. */
  connected(nodeId: string): boolean;
  /** Scans the outbox now (a hint: the dispatcher reads SQLite). Callers need not await it: it resolves
   * (never rejects) once no delivery is in progress. */
  wake(): Promise<void>;
  /** Delivers one command to the node of the session's source (see `deliverToNode`). */
  send(command: NodeCommand): Promise<NodeResult>;
  /** `session.close` to a node the session no longer runs on (a move or a deletion), if it is connected.
   * Best effort: never rejects; the node's calls for the session are refused either way. */
  closeSession(nodeId: string, sessionId: string): Promise<void>;
  /** `skills.list` on the node's link, bounded by the hub's `skills` timeout; rejects (an `RpcFailure`)
   * when the node is not connected, does not answer or refuses. Never queued. */
  listSkills(nodeId: string, source: SkillsList): Promise<SkillInfo[]>;
  /** The client that submitted an input hears of its failure (`notifySubmissionFailure`). */
  observeSubmission(sessionId: string, clientId: string, client: WsClient): void;
  forgetClient(client: WsClient): void;
  /** Starts the periodic outbox scan. */
  start(): void;
  /** Process shutdown: stops delivery and closes every node connection. */
  close(): void;
}

/** What the process owner holds across handler reloads. */
export interface ServerState {
  clients: Set<WsClient>;
  frontendDir: string;
  nodes: NodeHub;
}
