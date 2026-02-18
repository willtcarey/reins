/**
 * WebSocket Client
 *
 * Thin client that connects to the backend WebSocket endpoint.
 * The WS is a stateless broadcast channel:
 *  - Receives all active session events (each tagged with sessionId)
 *  - Sends commands (prompt, steer, abort) with explicit sessionId
 *
 * Session lifecycle (create, load, list) is handled via REST.
 */

// ---- Types ----------------------------------------------------------------

export interface SessionState {
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
}

export interface SessionData {
  id: string;
  task_id: number | null;
  messages: any[];
  state: SessionState;
}

export interface SessionListItem {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_message: string | null;
}

export interface TaskListItem {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  branch_name: string;
  created_at: string;
  updated_at: string;
  session_count: number;
  session_ids: string[];
}

export interface ProjectInfo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  created_at: string;
  last_opened_at: string;
}

/** Inbound message shapes from the backend */
export type ServerMessage =
  | { type: "event"; sessionId: string; event: any }
  | { type: "ack"; command: string }
  | { type: "error"; error: string };

export type EventListener = (sessionId: string, event: any) => void;
export type ConnectionListener = (connected: boolean) => void;

// ---- Client ----------------------------------------------------------------

export class AppClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private eventListeners = new Set<EventListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private connected = false;

  constructor(url?: string) {
    if (url) {
      this.url = url;
    } else {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${protocol}//${location.host}/ws`;
    }
  }

  // ---- Connection ----------------------------------------------------------

  connect(): void {
    if (this.ws) return;
    this.createSocket();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setConnected(false);
  }

  private createSocket(): void {
    const ws = new WebSocket(this.url);

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setConnected(true);
    };

    ws.onmessage = (evt) => {
      try {
        const msg: ServerMessage = JSON.parse(evt.data);
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };

    ws.onerror = () => {};

    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createSocket();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    for (const listener of this.connectionListeners) {
      listener(value);
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ---- Message handling ----------------------------------------------------

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "event":
        for (const listener of this.eventListeners) {
          listener(msg.sessionId, msg.event);
        }
        break;

      case "ack":
      case "error":
        // Forward as synthetic events for general listeners
        for (const listener of this.eventListeners) {
          listener("", { type: `ws_${msg.type}`, ...msg });
        }
        break;
    }
  }

  // ---- Commands ------------------------------------------------------------

  prompt(sessionId: string, message: string): void {
    this.send({ type: "prompt", sessionId, message });
  }

  steer(sessionId: string, message: string): void {
    this.send({ type: "steer", sessionId, message });
  }

  abort(sessionId: string): void {
    this.send({ type: "abort", sessionId });
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ---- Subscriptions -------------------------------------------------------

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
}
