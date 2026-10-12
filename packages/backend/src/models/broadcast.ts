/**
 * WebSocket Broadcast
 *
 * Typed broadcast abstraction. The `Broadcast` function sends a
 * `ServerMessage` to every browser connection, through the process
 * (`ServerProcess.broadcast`, which owns the connections). Entry points
 * get it from their `Models` (`models.broadcast`, built with
 * `createBroadcast`).
 *
 * The `ServerMessage` union is the single source of truth for every
 * broadcast payload shape — keep it in sync when adding new messages.
 */

import type { AgentRuntimeEvent, ImageReferenceBlock } from "../session-runtime/events.js";
import type { ServerProcess } from "../state.js";
import type { NodeView } from "./node.js";
// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ServerMessage =
  /** A session event, sent as `sessionEventFrame` builds it; `seq` lets a browser detect gaps and
   * `emittedAt` (the server's wall clock) measure latency. */
  | { type: "event"; sessionId: string; projectId: number; seq: number; emittedAt: number; event: AgentRuntimeEvent<ImageReferenceBlock> }
  | { type: "task_updated"; projectId: number }
  | { type: "session_created"; projectId: number; sessionId: string; taskId: number | null; parentSessionId: string | null }
  | { type: "session_updated"; sessionId: string; projectId: number }
  | { type: "code_review_updated"; projectId: number; taskId: number | null; reviewId: string; revision: number }
  | { type: "open_file"; sessionId: string; projectId: number; path: string; startLine?: number; endLine?: number }
  /** The node as it is now: it was paired (by pairing code `pairingCodeId`, `POST /api/nodes/pairing-codes`'s
   * `id`), connected, disconnected or was revoked. */
  | { type: "node_updated"; node: NodeView; pairingCodeId?: number }
  | { type: "node_removed"; nodeId: string }
  /** A session command failed with no single submitting client to notify (e.g. a node model change). */
  | { type: "error"; sessionId: string; error: string };

// ---------------------------------------------------------------------------
// Broadcast function
// ---------------------------------------------------------------------------

export type Broadcast = (message: ServerMessage) => void;

export function createBroadcast(serverProcess: ServerProcess): Broadcast {
  return (message) => serverProcess.broadcast(JSON.stringify(message));
}

/**
 * The `event` message for a session event, built around the runtime's serialized event (`eventJson`)
 * without parsing it. The envelope fields follow the payload: JSON.parse keeps the last of duplicate
 * keys, so nothing inside the payload can rewrite the session, project, sequence or message type.
 */
export function sessionEventFrame(sessionId: string, projectId: number, seq: number, emittedAt: number, eventJson: string): string {
  return `{"event":${eventJson},"type":"event","sessionId":${JSON.stringify(sessionId)},"projectId":${projectId},"seq":${seq},"emittedAt":${emittedAt}}`;
}
