/** Minimal in-memory AppClient test double. */
import type { ClientPromptContent } from "../../models/chat-content.js";
import {
  dispatchInboundMessage,
  type ConnectionListener,
  type IAppClient,
  type InboundMessage,
  type InboundMessageHandlers,
} from "../../models/ws-client.js";

export class StubClient implements IAppClient {
  private subscriptions = new Set<InboundMessageHandlers>();
  private connectionListeners = new Set<ConnectionListener>();

  subscribe(handlers: InboundMessageHandlers): () => void {
    this.subscriptions.add(handlers);
    return () => this.subscriptions.delete(handlers);
  }

  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  fireMessage(message: InboundMessage): void {
    for (const handlers of this.subscriptions) dispatchInboundMessage(handlers, message);
  }

  fireConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected);
  }

  connect() {}
  disconnect() {}
  get isConnected() { return false; }
  prompt(_sessionId: string, _message: ClientPromptContent, _submissionId: string) {}
  steer(_sessionId: string, _message: ClientPromptContent, _submissionId: string) {}
  abort(_sessionId: string) {}
}
