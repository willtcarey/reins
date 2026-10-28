/**
 * WebSocket Client
 *
 * Thin client that connects to the backend WebSocket endpoint. The WS is a broadcast channel: it receives
 * every session's events (each tagged with its sessionId) and session, task and node updates, and sends
 * only the heartbeat. Session operations (prompt, steer, abort) are HTTP requests (`SessionOperations`).
 */

// ---- Types ----------------------------------------------------------------

import type { NodeView } from "@backend/models/node.js";
import type { ChatEvent } from "./chat-state.js";
import { streamingTelemetry } from "./streaming-telemetry.js";

/** The messages the server sends, and what domain stores subscribe to. */
export type InboundMessage =
  /** `seq` counts a session's events on the server (restarting when the server process restarts); a jump means
   * events were missed. `emittedAt` is the server's wall clock when it emitted the event (diagnostics only). */
  | { type: "event"; sessionId: string; projectId: number; seq: number; emittedAt: number; event: ChatEvent }
  | { type: "task_updated"; projectId: number }
  | { type: "session_created"; projectId: number; sessionId: string; taskId: number | null; parentSessionId: string | null }
  | { type: "session_updated"; sessionId: string; projectId: number }
  | { type: "code_review_updated"; projectId: number; taskId: number | null; reviewId: string; revision: number }
  | { type: "open_file"; sessionId: string; projectId: number; path: string; startLine?: number; endLine?: number }
  /** A node as it is now: it was paired (by pairing code `pairingCodeId`), connected, disconnected or was revoked. */
  | { type: "node_updated"; node: NodeView; pairingCodeId?: number }
  | { type: "node_removed"; nodeId: string };

export type InboundMessageKind = InboundMessage["type"];
export type InboundMessageOf<K extends InboundMessageKind> = Extract<InboundMessage, { type: K }>;
export type InboundMessageListener<K extends InboundMessageKind> = (message: InboundMessageOf<K>) => void;
export type InboundMessageHandlers = {
  [K in InboundMessageKind]?: InboundMessageListener<K>;
};
export type ConnectionListener = (connected: boolean) => void;

/** Typed, kind-filtered source shared by aggregate and scoped stores. */
export interface InboundEventSource {
  subscribe(handlers: InboundMessageHandlers): () => void;
}

/** Dispatch while preserving the relationship between each kind and its envelope. */
export function dispatchInboundMessage(handlers: InboundMessageHandlers, message: InboundMessage): void {
  switch (message.type) {
    case "event": handlers.event?.(message); break;
    case "task_updated": handlers.task_updated?.(message); break;
    case "session_created": handlers.session_created?.(message); break;
    case "session_updated": handlers.session_updated?.(message); break;
    case "code_review_updated": handlers.code_review_updated?.(message); break;
    case "open_file": handlers.open_file?.(message); break;
    case "node_updated": handlers.node_updated?.(message); break;
    case "node_removed": handlers.node_removed?.(message); break;
  }
}

// ---- Public interface (for test doubles) ------------------------------------

export interface IAppClient extends InboundEventSource {
  connect(): void;
  disconnect(): void;
  readonly isConnected: boolean;
  onConnection(listener: ConnectionListener): () => void;
}

// ---- Client ----------------------------------------------------------------

export class AppClient implements IAppClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private eventSubscriptions = new Set<InboundMessageHandlers>();
  private connectionListeners = new Set<ConnectionListener>();
  private connected = false;

  // Heartbeat — detect stale connections before the user sends a message
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 5_000;

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
  }

  private createSocket(): void {
    const ws = new WebSocket(this.url);

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setConnected(true);
      this.startHeartbeat();
    };

    ws.onmessage = (evt) => {
      const receivedAt = streamingTelemetry.enabled ? streamingTelemetry.now() : 0;
      try {
        const msg = JSON.parse(evt.data);
        this.handleMessage(msg);
        if (streamingTelemetry.enabled && msg.type === "event") {
          streamingTelemetry.socketEvent({
            receivedAt,
            handledMs: streamingTelemetry.now() - receivedAt,
            latencyMs: Date.now() - msg.emittedAt,
            bytes: evt.data.length,
          });
        }
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

  // ---- Reconnect ----------------------------------------------------------

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

  private handleMessage(msg: InboundMessage | { type: "pong" }): void {
    if (msg.type === "pong") {
      this.clearHeartbeatTimeout();
      return;
    }
    this.publish(msg);
  }

  private publish(message: InboundMessage): void {
    for (const handlers of this.eventSubscriptions) dispatchInboundMessage(handlers, message);
  }

  // ---- Subscriptions -------------------------------------------------------

  subscribe(handlers: InboundMessageHandlers): () => void {
    this.eventSubscriptions.add(handlers);
    return () => this.eventSubscriptions.delete(handlers);
  }

  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
}
