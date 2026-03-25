/**
 * Minimal test double for AppClient.
 *
 * Implements the full public API so it's structurally compatible
 * with AppClient and can be passed anywhere one is expected.
 */
import type { IAppClient, EventListener, ConnectionListener } from "../../models/ws-client.js";

export class StubClient implements IAppClient {
  private eventListeners = new Set<EventListener>();
  private connectionListeners = new Set<ConnectionListener>();

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  // ---- Test helpers --------------------------------------------------------

  fireEvent(sessionId: string, projectId: number, event: Parameters<EventListener>[2]) {
    for (const l of this.eventListeners) l(sessionId, projectId, event);
  }

  fireConnection(connected: boolean) {
    for (const l of this.connectionListeners) l(connected);
  }

  // ---- AppClient public API (no-ops) ---------------------------------------

  connect() {}
  disconnect() {}
  get isConnected() { return false; }
  prompt(_sessionId: string, _message: string) {}
  steer(_sessionId: string, _message: string) {}
  abort(_sessionId: string) {}
}
