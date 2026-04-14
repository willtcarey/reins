/**
 * WebSocket Broadcast
 *
 * Typed broadcast abstraction. The `Broadcast` function sends a
 * `ServerMessage` to every connected WS client.  It's created via
 * `createBroadcast(state.clients)` at bundle entry points (routes,
 * WS handlers) so the rest of the codebase never touches the raw
 * client set or `ServerState`.
 *
 * The `ServerMessage` union is the single source of truth for every
 * broadcast payload shape — keep it in sync when adding new messages.
 */

import type { AgentRuntimeEvent } from "../runtimes/registry.js";
import type { WsClient } from "../state.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "event"; sessionId: string; projectId: number; event: AgentRuntimeEvent }
  | { type: "task_updated"; projectId: number }
  | { type: "session_created"; projectId: number; sessionId: string; taskId: number | null }
  | { type: "session_updated"; sessionId: string; projectId: number }
  | { type: "user_message"; sessionId: string; projectId: number; message: string }
  | { type: "open_file"; sessionId: string; projectId: number; path: string; startLine?: number; endLine?: number };

// ---------------------------------------------------------------------------
// Broadcast function
// ---------------------------------------------------------------------------

export type Broadcast = (message: ServerMessage) => void;

export function createBroadcast(clients: Set<WsClient>): Broadcast {
  return (message) => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      try {
        client.ws.send(payload);
      } catch {}
    }
  };
}

/** Like createBroadcast, but skips one client (e.g. the command sender). */
export function createBroadcastExcluding(clients: Set<WsClient>, exclude: WsClient): Broadcast {
  return (message) => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client === exclude) continue;
      try {
        client.ws.send(payload);
      } catch {}
    }
  };
}
