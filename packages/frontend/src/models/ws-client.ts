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
  parent_session_id: string | null;
}

export interface TaskListItem {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  branch_name: string;
  status: "open" | "closed";
  created_at: string;
  updated_at: string;
  session_count: number;
  session_ids: string[];
  diffStats: { additions: number; removals: number } | null;
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
  | { type: "event"; sessionId: string; projectId: number; event: any }
  | { type: "task_updated"; projectId: number }
  | { type: "session_created"; projectId: number; sessionId: string; taskId: number | null }
  | { type: "user_message"; sessionId: string; projectId: number; message: string }
  | { type: "ack"; command: string }
  | { type: "error"; error: string };

export type EventListener = (sessionId: string, projectId: number, event: any) => void;
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

  // Heartbeat — detect stale connections before the user sends a message
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 5_000;

  // Outbound buffer — replay last command on reconnect if connection drops after send
  private lastOutboundMessage: string | null = null;
  private pendingReplay = false;

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
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setConnected(false);
    this.clearReplayBuffer();
  }

  private createSocket(): void {
    const ws = new WebSocket(this.url);

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setConnected(true);
      this.startHeartbeat();
      this.replayIfPending();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      this.setConnected(false);
      this.scheduleReconnect();
    };

    ws.onerror = () => {};

    this.ws = ws;
  }

  // ---- Heartbeat -----------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
        this.heartbeatTimeout = setTimeout(() => {
          // No pong received — connection is dead, force close
          if (this.ws) {
            this.ws.close();
          }
        }, AppClient.HEARTBEAT_TIMEOUT_MS);
      }
    }, AppClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  // ---- Outbound replay -----------------------------------------------------

  private replayIfPending(): void {
    if (this.pendingReplay && this.lastOutboundMessage) {
      const msg = this.lastOutboundMessage;
      this.clearReplayBuffer();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      }
    }
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

  private handleMessage(msg: ServerMessage | { type: "pong" }): void {
    switch (msg.type) {
      case "pong":
        this.clearHeartbeatTimeout();
        break;

      case "event":
        for (const listener of this.eventListeners) {
          listener(msg.sessionId, msg.projectId, msg.event);
        }
        break;

      case "task_updated":
        // Forward as a synthetic event so app-level listeners can react
        for (const listener of this.eventListeners) {
          listener("", msg.projectId, { type: "task_updated", projectId: msg.projectId });
        }
        break;

      case "session_created":
        for (const listener of this.eventListeners) {
          listener("", msg.projectId, {
            type: "session_created",
            projectId: msg.projectId,
            sessionId: msg.sessionId,
            taskId: msg.taskId,
          });
        }
        break;

      case "user_message":
        for (const listener of this.eventListeners) {
          listener(msg.sessionId, msg.projectId, {
            type: "user_message",
            message: msg.message,
          });
        }
        break;

      case "ack":
        this.clearReplayBuffer();
        for (const listener of this.eventListeners) {
          listener("", 0, { ...msg, type: `ws_${msg.type}` });
        }
        break;

      case "error":
        this.clearReplayBuffer();
        for (const listener of this.eventListeners) {
          listener("", 0, { ...msg, type: `ws_${msg.type}` });
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
    const json = JSON.stringify(data);
    this.lastOutboundMessage = json;
    this.pendingReplay = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  /**
   * Called when the server acks a command — clear the replay buffer
   * since the message was delivered successfully.
   */
  private clearReplayBuffer(): void {
    this.pendingReplay = false;
    this.lastOutboundMessage = null;
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
