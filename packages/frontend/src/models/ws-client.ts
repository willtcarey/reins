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

import type { ChatEvent } from "./chat-state.js";
import type { ClientPromptContent } from "./chat-content.js";
import { streamingTelemetry } from "./streaming-telemetry.js";

/** Inbound message shapes from the backend */
export type ServerMessage =
  /** `seq` counts a session's events on its node (restarting when the node restarts); a jump means events were missed.
   * `emittedAt` is the node's wall clock when it emitted the event (diagnostics only). */
  | { type: "event"; sessionId: string; projectId: number; seq: number; emittedAt: number; event: ChatEvent }
  | { type: "task_updated"; projectId: number }
  | { type: "session_created"; projectId: number; sessionId: string; taskId: number | null; parentSessionId: string | null }
  | { type: "session_updated"; sessionId: string; projectId: number }
  | { type: "code_review_updated"; projectId: number; taskId: number | null; reviewId: string; revision: number }
  | { type: "open_file"; sessionId: string; projectId: number; path: string; startLine?: number; endLine?: number }
  | { type: "ack"; command: string; clientId?: string }
  | { type: "error"; sessionId?: string; clientId?: string; error: string };

/** Messages exposed to domain stores. Command acknowledgements are transport-only. */
export type InboundMessage = Exclude<ServerMessage, { type: "ack" }>;
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
    case "error": handlers.error?.(message); break;
  }
}

// ---- Public interface (for test doubles) ------------------------------------

export interface IAppClient extends InboundEventSource {
  connect(): void;
  disconnect(): void;
  readonly isConnected: boolean;
  prompt(sessionId: string, message: ClientPromptContent, clientId: string): void;
  steer(sessionId: string, message: ClientPromptContent, clientId: string): void;
  abort(sessionId: string): void;
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

  // Submission-keyed outbound buffer. Acknowledgements clear only their own
  // command, so rapid prompt/steer submissions survive disconnects exactly once.
  private pendingOutboundMessages = new Map<string, string>();

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
    this.pendingOutboundMessages.clear();
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

  // ---- Outbound replay -----------------------------------------------------

  private replayIfPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const message of this.pendingOutboundMessages.values()) this.ws.send(message);
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
    if (msg.type === "pong") {
      this.clearHeartbeatTimeout();
      return;
    }
    if (msg.type === "ack") {
      this.clearReplayBuffer(msg.clientId ?? msg.command);
      return;
    }
    if (msg.type === "error" && msg.clientId) this.clearReplayBuffer(msg.clientId);
    this.publish(msg);
  }

  private publish(message: InboundMessage): void {
    for (const handlers of this.eventSubscriptions) dispatchInboundMessage(handlers, message);
  }

  // ---- Commands ------------------------------------------------------------

  prompt(sessionId: string, message: ClientPromptContent, clientId: string): void {
    this.send({ type: "prompt", sessionId, clientId, message }, clientId);
  }

  steer(sessionId: string, message: ClientPromptContent, clientId: string): void {
    this.send({ type: "steer", sessionId, clientId, message }, clientId);
  }

  abort(sessionId: string): void {
    this.send({ type: "abort", sessionId }, "abort");
  }

  private send(data: unknown, replayId: string): void {
    const json = JSON.stringify(data);
    this.pendingOutboundMessages.set(replayId, json);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  /**
   * Called when the server acks a command — clear the replay buffer
   * since the message was delivered successfully.
   */
  private clearReplayBuffer(replayId: string): void {
    this.pendingOutboundMessages.delete(replayId);
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
