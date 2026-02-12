/**
 * Herald Server State (shared types)
 *
 * Type definitions for the long-lived state that survives hot reloads.
 * The actual state objects are owned by index.ts; handlers.ts receives
 * them as parameters.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface ManagedSession {
  session: AgentSession;
  id: string;
  lastActivity: number;
}

export interface WsClient {
  ws: any; // Bun ServerWebSocket
  activeSessionId: string | null;
}

export interface ServerState {
  sessions: Map<string, ManagedSession>;
  clients: Set<WsClient>;
  defaultSessionId: string;
  projectDir: string;
  frontendDir: string;
  explicitModel: any | undefined;
}
