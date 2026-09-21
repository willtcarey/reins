/**
 * Canonical conversation ownership. Durable pages and WebSocket entries share
 * one envelope and enter through one idempotent upsert path. Optimistic
 * submissions and streaming assistants remain explicit overlays.
 */

import {
  applyChatEvent,
  initialChatState,
  removePersistedStreamingAssistants,
  type ChatEvent,
  type ChatState,
} from "../chat-state.js";
import type { ClientPromptContent } from "../chat-content.js";
import { buildMessages, buildStreamingMessages, type AssistantMessage, type Message } from "../message.js";
import type { ConversationEntry as BackendConversationEntry, SessionMessagePage } from "@backend/messages-store.js";
import type { AgentMessage } from "../agent-message.js";
import type { InboundEventSource } from "../ws-client.js";
import { api } from "../reins-client.js";
import type { SessionCache } from "./session-cache.js";

export interface ConversationEntry extends Omit<BackendConversationEntry, "message"> {
  message: AgentMessage;
}

export interface LiveConversationEntry {
  id: null;
  parentId: null;
  seq: null;
  localId: string;
  clientId: string;
  message: AgentMessage;
}

export interface MessageRecordPage extends Omit<SessionMessagePage, "items"> {
  items: ConversationEntry[];
}

interface ConversationState extends Omit<ChatState, "messages"> {
  entries: ConversationEntry[];
  pendingSubmissions: Map<string, LiveConversationEntry>;
  previousCursor: string | null;
  latestCursor: string | null;
}

interface ConversationUpdate extends Partial<Omit<ConversationState, "entries">> {
  entries?: ConversationEntry[];
}

export interface ConversationView {
  messages: Message[];
  streamingMessages: AssistantMessage[];
  hasEarlierMessages: boolean;
  isCompacting: boolean;
  errorMessage: string;
}

type ConversationsStoreListener = () => void;
interface ConversationsStoreOptions { sessionCache?: SessionCache; eventSource?: InboundEventSource }

function blankConversationState(): ConversationState {
  const state = initialChatState();
  return {
    entries: [],
    pendingSubmissions: new Map(),
    previousCursor: null,
    latestCursor: null,
    streamingAssistants: state.streamingAssistants,
    isCompacting: state.isCompacting,
    errorMessage: state.errorMessage,
  };
}

/** Idempotent canonical upsert. Harness sequence is the transcript order. */
function upsertEntries(current: readonly ConversationEntry[], incoming: readonly ConversationEntry[]): ConversationEntry[] {
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) entries.set(entry.id, entry);
  return [...entries.values()].toSorted((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

export class ConversationsStore {
  private _states = new Map<string, ConversationState>();
  private _listeners = new Map<string, Set<ConversationsStoreListener>>();
  private _syncs = new Map<string, Promise<boolean>>();
  private _sessionCache: SessionCache | null;
  private _unsubscribeSessionCache: (() => void) | null = null;
  private _unsubscribeEvents: (() => void) | null = null;

  constructor(options: ConversationsStoreOptions = {}) {
    this._sessionCache = options.sessionCache ?? null;
    this._unsubscribeSessionCache = this._sessionCache?.subscribeAll((sessionId) => this.pruneSessionIfInactive(sessionId)) ?? null;
    this._unsubscribeEvents = options.eventSource?.subscribe({
      event: (message) => this.applyEvent(message.sessionId, message.event),
      error: (message) => {
        if (!message.sessionId) return;
        if (message.clientId) this.rejectPendingSubmission(message.sessionId, message.clientId);
        this.setError(message.sessionId, message.error || "Something went wrong");
      },
    }) ?? null;
  }

  get(sessionId: string): ConversationView {
    const state = sessionId ? this.stateFor(sessionId) : blankConversationState();
    const entries = [...state.entries, ...state.pendingSubmissions.values()];
    return {
      messages: buildMessages(entries.map((entry) => ({
        entryId: entry.id,
        parentEntryId: entry.parentId,
        renderKey: entry.clientId
          ? `submission-${entry.clientId}`
          : entry.id!,
        message: entry.message,
      }))),
      streamingMessages: buildStreamingMessages(state.streamingAssistants),
      hasEarlierMessages: state.previousCursor !== null,
      isCompacting: state.isCompacting,
      errorMessage: state.errorMessage,
    };
  }

  async syncMessages(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const existing = this._syncs.get(sessionId);
    if (existing) return existing;
    const sync = this.fetchMessageTail(sessionId).finally(() => this._syncs.delete(sessionId));
    this._syncs.set(sessionId, sync);
    return sync;
  }

  private async fetchMessageTail(sessionId: string): Promise<boolean> {
    let after = this.stateFor(sessionId).latestCursor;
    try {
      while (true) {
        const page = await api.sessions.messages(sessionId, after === null ? {} : { after });
        this.mergeMessages(sessionId, page);
        if (!page.pageInfo.hasNextPage) return true;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) return false;
        after = page.pageInfo.endCursor;
      }
    } catch {
      return false;
    }
  }

  async loadEarlierMessages(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const before = this.stateFor(sessionId).previousCursor;
    if (!before) return false;
    try {
      this.mergeMessages(sessionId, await api.sessions.messages(sessionId, { before }), { earlier: true });
      return true;
    } catch {
      return false;
    }
  }

  subscribe(sessionId: string, listener: ConversationsStoreListener): () => void {
    if (!sessionId) return () => {};
    const listeners = this._listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this._listeners.set(sessionId, listeners);
    return () => {
      const current = this._listeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) {
        this._listeners.delete(sessionId);
        this.pruneSessionIfInactive(sessionId);
      }
    };
  }

  addOptimisticUserMessage(
    sessionId: string,
    content: ClientPromptContent,
    clientId: string,
    timestamp = Date.now(),
  ): LiveConversationEntry | null {
    return this.addPendingSubmission(sessionId, content, clientId, timestamp);
  }

  private addPendingSubmission(
    sessionId: string,
    content: ClientPromptContent,
    clientId: string,
    timestamp: number,
    metadata?: Record<string, unknown>,
  ): LiveConversationEntry | null {
    if (!sessionId) return null;
    const state = this.stateFor(sessionId);
    if (state.pendingSubmissions.has(clientId) || state.entries.some((entry) => entry.clientId === clientId)) return null;
    const entry: LiveConversationEntry = {
      id: null,
      parentId: null,
      seq: null,
      clientId,
      localId: `submission-${clientId}`,
      message: { role: "user", content, ...(metadata ? { metadata } : {}), timestamp },
    };
    const pendingSubmissions = new Map(state.pendingSubmissions);
    pendingSubmissions.set(clientId, entry);
    this.update(sessionId, { pendingSubmissions });
    return entry;
  }

  mergeMessages(sessionId: string, page: MessageRecordPage, options: { earlier?: boolean } = {}): void {
    if (!sessionId) return;
    this.update(sessionId, (state) => ({
      entries: page.items,
      previousCursor: options.earlier || state.entries.length === 0 ? page.pageInfo.previousCursor : state.previousCursor,
      latestCursor: options.earlier ? state.latestCursor : page.pageInfo.endCursor,
    }));
  }

  applyEvent(sessionId: string, event: ChatEvent): void {
    if (!sessionId) return;
    if (event.type === "entry_added") {
      this.update(sessionId, { entries: [event.entry] });
      return;
    }
    this.update(sessionId, (state) => {
      const messages = [
        ...state.entries.map(({ message }) => message),
        ...[...state.pendingSubmissions.values()].map(({ message }) => message),
      ];
      const next = applyChatEvent({ ...state, messages }, event);
      if (next.streamingAssistants === state.streamingAssistants
        && next.isCompacting === state.isCompacting
        && next.errorMessage === state.errorMessage) return undefined;
      return {
        streamingAssistants: next.streamingAssistants,
        isCompacting: next.isCompacting,
        errorMessage: next.errorMessage,
      };
    });
  }

  private rejectPendingSubmission(sessionId: string, clientId: string): void {
    const state = this.stateFor(sessionId);
    if (!state.pendingSubmissions.has(clientId)) return;
    const pendingSubmissions = new Map(state.pendingSubmissions);
    pendingSubmissions.delete(clientId);
    this.update(sessionId, { pendingSubmissions });
  }

  clearCompactingState(sessionId: string): void {
    if (sessionId) this.update(sessionId, (state) => state.isCompacting ? { isCompacting: false } : undefined);
  }
  setError(sessionId: string, errorMessage: string): void { if (sessionId) this.update(sessionId, { errorMessage }); }
  clearError(sessionId: string): void { this.setError(sessionId, ""); }

  pruneInactive(): void { for (const sessionId of this._states.keys()) this.pruneSessionIfInactive(sessionId); }
  dispose(): void {
    this._unsubscribeSessionCache?.();
    this._unsubscribeEvents?.();
    this._unsubscribeSessionCache = null;
    this._unsubscribeEvents = null;
    this._listeners.clear();
    this._syncs.clear();
    this._states.clear();
  }

  private pruneSessionIfInactive(sessionId: string): void {
    if (!this._states.has(sessionId) || this._listeners.has(sessionId)) return;
    if (this._sessionCache?.get(sessionId)?.activityState === "running") return;
    if (this._states.delete(sessionId)) this.notify(sessionId);
  }

  private stateFor(sessionId: string): ConversationState { return this._states.get(sessionId) ?? blankConversationState(); }

  private update(
    sessionId: string,
    build: ConversationUpdate | ((state: ConversationState) => ConversationUpdate | undefined),
  ): void {
    const current = this.stateFor(sessionId);
    const patch = typeof build === "function" ? build(current) : build;
    if (!patch) return;
    const entries = patch.entries ? upsertEntries(current.entries, patch.entries) : current.entries;
    const pendingSubmissions = new Map(patch.pendingSubmissions ?? current.pendingSubmissions);
    for (const entry of entries) if (entry.clientId) pendingSubmissions.delete(entry.clientId);
    const reconciled = removePersistedStreamingAssistants(
      { streamingAssistants: patch.streamingAssistants ?? current.streamingAssistants },
      new Set(entries.map(({ id }) => id)),
    );
    this._states.set(sessionId, {
      ...current,
      ...patch,
      entries,
      pendingSubmissions,
      streamingAssistants: reconciled.streamingAssistants,
    });
    this.notify(sessionId);
  }

  private notify(sessionId: string): void {
    for (const listener of this._listeners.get(sessionId) ?? []) listener();
  }
}
