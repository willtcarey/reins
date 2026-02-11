/**
 * Herald WebSocket Client
 *
 * Thin client that connects to the Herald backend WebSocket endpoint,
 * sends commands (prompt, steer, abort, get_state, get_messages),
 * and dispatches incoming events to subscribers.
 */

// ---- Types ----------------------------------------------------------------

export interface HeraldState {
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
}

export interface InitPayload {
  messages: any[];
  state: HeraldState;
  sessionId: string;
}

export interface SessionListItem {
  path: string;
  id: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

/** Inbound message shapes from the backend */
export type ServerMessage =
  | { type: "init"; data: InitPayload }
  | { type: "event"; event: any }
  | { type: "ack"; command: string }
  | { type: "state"; data: HeraldState }
  | { type: "messages"; data: { messages: any[] } }
  | { type: "error"; error: string };

export type EventListener = (event: any) => void;
export type ConnectionListener = (connected: boolean) => void;
export type InitListener = (data: InitPayload) => void;

// ---- Client ----------------------------------------------------------------

export class HeraldClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private eventListeners = new Set<EventListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private initListeners = new Set<InitListener>();
  private connected = false;

  constructor(url?: string) {
    // Default: derive WebSocket URL from current page location
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
      this.ws.onclose = null; // prevent reconnect
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

    ws.onerror = () => {
      // onerror is always followed by onclose in browsers
    };

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
      case "init":
        for (const listener of this.initListeners) {
          listener(msg.data);
        }
        break;

      case "event":
        for (const listener of this.eventListeners) {
          listener(msg.event);
        }
        break;

      case "state":
      case "messages":
      case "ack":
      case "error":
        // These are handled by promise-based request/response if needed,
        // but also forwarded as events for general listeners
        for (const listener of this.eventListeners) {
          listener({ type: `ws_${msg.type}`, ...msg });
        }
        break;
    }
  }

  // ---- Commands ------------------------------------------------------------

  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  steer(message: string): void {
    this.send({ type: "steer", message });
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  getState(): void {
    this.send({ type: "get_state" });
  }

  getMessages(): void {
    this.send({ type: "get_messages" });
  }

  switchSession(sessionPath: string): void {
    this.send({ type: "switch_session", sessionPath });
  }

  newSession(): void {
    this.send({ type: "new_session" });
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

  onInit(listener: InitListener): () => void {
    this.initListeners.add(listener);
    return () => this.initListeners.delete(listener);
  }
}
