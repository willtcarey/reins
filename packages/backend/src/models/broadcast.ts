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

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { WsClient } from "../state.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "event"; sessionId: string; event: AgentSessionEvent }
  | { type: "task_updated"; projectId: number };

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
