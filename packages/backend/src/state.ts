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

import type { AgentRuntime } from "./runtimes/registry.js";
import type { ReinsResourceLoader } from "./runtimes/resource-loader.js";

export interface ManagedSession {
  runtime: AgentRuntime;
  id: string;
  lastActivity: number;
  resourceLoader: ReinsResourceLoader;
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
}
