/**
 * Server State (shared types)
 *
 * Type definitions for the long-lived state that survives hot reloads.
 * The actual state objects are owned by index.ts; handlers.ts receives
 * them as parameters. The server holds no session runtimes: sessions run on nodes.
 *
 * Project context is NOT stored globally — it flows from the request:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   broadcast all active session events (tagged with sessionId),
 *           receive `prompt`, `steer`, `abort` (each with explicit sessionId).
 */

/** Minimal interface for WebSocket objects — matches Bun's ServerWebSocket. */
export interface WebSocketLike {
  send(data: string, compress?: boolean): number;
}

export interface WsClient {
  ws: WebSocketLike;
}

export interface ServerState {
  clients: Set<WsClient>;
  frontendDir: string;
}
