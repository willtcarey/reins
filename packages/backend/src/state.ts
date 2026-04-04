/**
 * Server State (shared types)
 *
 * Type definitions for the long-lived state that survives hot reloads.
 * The actual state objects are owned by index.ts; handlers.ts receives
 * them as parameters.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

export interface ManagedSession {
  session: AgentSession;
  id: string;
  lastActivity: number;
}

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

export interface WsClient {
  ws: WebSocketLike;
}

export interface ServerState {
  sessions: Map<string, ManagedSession>;
  clients: Set<WsClient>;
  frontendDir: string;
  explicitModel: Model<Api> | undefined;
  /** Encryption secret for settings store (derived from REINS_SECRET or auto-generated). */
  encryptionSecret: Buffer;
}
