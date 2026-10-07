/**
 * Canonical conversation ownership. Durable pages and WebSocket entries share
 * one envelope and enter through one idempotent upsert path. Optimistic
 * submissions and streaming assistants remain explicit overlays.
 *
 * Events apply to state immediately. Streaming partials (`message_update`,
 * `tool_execution_update`) notify listeners at most once per animation frame
 * per session; every other change notifies synchronously and absorbs any
 * pending frame. Views are memoized so streaming-only changes keep transcript
 * `Message` objects identical.
 */

import {
  applyChatEvent,
  initialChatState,
  markStreamsStale,
  removePersistedStreamingAssistants,
  type ChatEvent,
  type ChatState,
} from "../chat-state.js";
import type { ClientPromptContent } from "../chat-content.js";
import { buildMessages, buildStreamingMessages, type AssistantMessage, type Message } from "../message.js";
import { streamingTelemetry, type StreamingTelemetry } from "../streaming-telemetry.js";
import type { ConversationEntry as BackendConversationEntry, SessionMessagePage } from "@backend/messages-store.js";
import type { AgentMessage } from "../agent-message.js";
import type { InboundEventSource } from "../ws-client.js";
import { api } from "../api.js";
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

interface ConversationState extends ChatState {
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

/** Schedule `callback` for the next frame; returns a cancel function. */
export type FrameScheduler = (callback: () => void) => () => void;

interface ConversationsStoreOptions {
  sessionCache?: SessionCache;
  eventSource?: InboundEventSource;
  /** Frame scheduler for streaming notifications; `null` notifies synchronously. Defaults to requestAnimationFrame. */
  scheduleFrame?: FrameScheduler | null;
  telemetry?: StreamingTelemetry;
}

interface PendingNotification {
  cancel: () => void;
  events: number;
  streamIds: Set<string>;
  firstReceivedAt: number;
}

interface ViewCache {
  state: ConversationState;
  view: ConversationView;
}

/** Hidden tabs do not run animation frames; notify at least this often anyway. */
const FRAME_FALLBACK_MS = 1000;

/** requestAnimationFrame with a timeout fallback, or null where frames are unavailable. */
function animationFrameScheduler(): FrameScheduler | null {
  if (typeof globalThis.requestAnimationFrame !== "function") return null;
  return (callback) => {
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
    const run = () => {
      cancel();
      callback();
    };
    frame = requestAnimationFrame(run);
    timer = setTimeout(run, FRAME_FALLBACK_MS);
    return cancel;
  };
}

function isStreamingPartial(event: ChatEvent): boolean {
  return event.type === "message_update" || event.type === "tool_execution_update";
}

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
  /** Last session event `seq` received per session, to detect missed events. */
  private _eventSeqs = new Map<string, number>();
  private _views = new Map<string, ViewCache>();
  private _pendingNotifications = new Map<string, PendingNotification>();
  private _scheduleFrame: FrameScheduler | null | undefined;
  private _telemetry: StreamingTelemetry;
  private _sessionCache: SessionCache | null;
  private _unsubscribeSessionCache: (() => void) | null = null;
  private _unsubscribeEvents: (() => void) | null = null;

  constructor(options: ConversationsStoreOptions = {}) {
    this._sessionCache = options.sessionCache ?? null;
    this._scheduleFrame = options.scheduleFrame;
    this._telemetry = options.telemetry ?? streamingTelemetry;
    this._unsubscribeSessionCache = this._sessionCache?.subscribeAll((sessionId) => this.pruneSessionIfInactive(sessionId)) ?? null;
    this._unsubscribeEvents = options.eventSource?.subscribe({
      event: (message) => this.applyEvent(message.sessionId, message.event, message.seq),
      error: (message) => {
        if (!message.sessionId) return;
        if (message.clientId) this.rejectPendingSubmission(message.sessionId, message.clientId);
        this.setError(message.sessionId, message.error || "Something went wrong");
      },
    }) ?? null;
  }

  /** Memoized per state; transcript and streaming messages are rebuilt only when their inputs change. */
  get(sessionId: string): ConversationView {
    const state = sessionId ? this.stateFor(sessionId) : blankConversationState();
    const cached = this._views.get(sessionId);
    if (cached?.state === state) return cached.view;
    const previous = cached?.state;
    const view: ConversationView = {
      messages: cached && previous?.entries === state.entries && previous.pendingSubmissions === state.pendingSubmissions
        ? cached.view.messages
        : buildTranscript(state),
      streamingMessages: cached && previous?.streamingAssistants === state.streamingAssistants
        ? cached.view.streamingMessages
        : buildStreamingMessages(state.streamingAssistants),
      hasEarlierMessages: state.previousCursor !== null,
      isCompacting: state.isCompacting,
      errorMessage: state.errorMessage,
    };
    if (this._states.get(sessionId) === state) this._views.set(sessionId, { state, view });
    return view;
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

  /** `seq` is the event's session sequence; any jump (missed events, a reconnect that lost some, a node
   * restart) marks the session's streaming overlays stale before the event applies. */
  applyEvent(sessionId: string, event: ChatEvent, seq?: number): void {
    if (!sessionId) return;
    if (seq !== undefined) {
      const last = this._eventSeqs.get(sessionId);
      this._eventSeqs.set(sessionId, seq);
      if (last !== undefined && seq !== last + 1) {
        this.update(sessionId, (state) => {
          const stale = markStreamsStale(state);
          return stale === state ? undefined : { streamingAssistants: stale.streamingAssistants };
        });
      }
    }
    if (event.type === "entry_added") {
      this.update(sessionId, { entries: [event.entry] });
      return;
    }
    this.update(sessionId, (state) => {
      const next = applyChatEvent(state, event);
      if (next.streamingAssistants === state.streamingAssistants
        && next.isCompacting === state.isCompacting
        && next.errorMessage === state.errorMessage) return undefined;
      return {
        streamingAssistants: next.streamingAssistants,
        isCompacting: next.isCompacting,
        errorMessage: next.errorMessage,
      };
    }, isStreamingPartial(event) ? event : null);
  }

  /** Synchronously deliver pending frame-batched notifications (all sessions when omitted). */
  flushNotifications(sessionId?: string): void {
    const sessionIds = sessionId === undefined ? [...this._pendingNotifications.keys()] : [sessionId];
    for (const id of sessionIds) if (this._pendingNotifications.has(id)) this.notify(id);
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
    for (const pending of this._pendingNotifications.values()) pending.cancel();
    this._pendingNotifications.clear();
    this._listeners.clear();
    this._syncs.clear();
    this._eventSeqs.clear();
    this._states.clear();
    this._views.clear();
  }

  private pruneSessionIfInactive(sessionId: string): void {
    if (!this._states.has(sessionId) || this._listeners.has(sessionId)) return;
    if (this._sessionCache?.get(sessionId)?.activityState === "running") return;
    this._eventSeqs.delete(sessionId);
    this._views.delete(sessionId);
    if (this._states.delete(sessionId)) this.notify(sessionId);
  }

  private stateFor(sessionId: string): ConversationState { return this._states.get(sessionId) ?? blankConversationState(); }

  /**
   * Apply a patch and notify. Passing the streaming partial that caused the
   * change defers notification to the next frame; anything else notifies now.
   */
  private update(
    sessionId: string,
    build: ConversationUpdate | ((state: ConversationState) => ConversationUpdate | undefined),
    streamingPartial: ChatEvent | null = null,
  ): void {
    const current = this.stateFor(sessionId);
    const patch = typeof build === "function" ? build(current) : build;
    if (!patch) return;
    const entries = patch.entries ? upsertEntries(current.entries, patch.entries) : current.entries;
    let pendingSubmissions = patch.pendingSubmissions ?? current.pendingSubmissions;
    const reconciledClientIds = patch.entries?.flatMap(({ clientId }) => (
      clientId && pendingSubmissions.has(clientId) ? [clientId] : []
    )) ?? [];
    if (reconciledClientIds.length > 0) {
      pendingSubmissions = new Map(pendingSubmissions);
      for (const clientId of reconciledClientIds) pendingSubmissions.delete(clientId);
    }
    let streamingAssistants = patch.streamingAssistants ?? current.streamingAssistants;
    // Only overlays that learned a durable ID can be superseded by an entry.
    if ((patch.entries || patch.streamingAssistants) && streamingAssistants.some(({ durableId }) => durableId)) {
      streamingAssistants = removePersistedStreamingAssistants(
        { streamingAssistants },
        new Set(entries.map(({ id }) => id)),
      ).streamingAssistants;
    }
    this._states.set(sessionId, {
      ...current,
      ...patch,
      entries,
      pendingSubmissions,
      streamingAssistants,
    });
    if (streamingPartial) this.notifyNextFrame(sessionId, streamingPartial);
    else this.notify(sessionId);
  }

  private notifyNextFrame(sessionId: string, event: ChatEvent): void {
    // Sessions nobody is viewing stay cheap: state is current, nothing renders.
    if (!this._listeners.has(sessionId)) return;
    let pending = this._pendingNotifications.get(sessionId);
    if (!pending) {
      const scheduleFrame = this._scheduleFrame === undefined ? animationFrameScheduler() : this._scheduleFrame;
      if (!scheduleFrame) {
        this.notify(sessionId);
        return;
      }
      pending = {
        cancel: scheduleFrame(() => this.notify(sessionId)),
        events: 0,
        streamIds: new Set(),
        firstReceivedAt: this._telemetry.now(),
      };
      this._pendingNotifications.set(sessionId, pending);
    }
    pending.events += 1;
    if ("streamId" in event) pending.streamIds.add(event.streamId);
  }

  private notify(sessionId: string): void {
    const pending = this._pendingNotifications.get(sessionId);
    if (pending) {
      this._pendingNotifications.delete(sessionId);
      pending.cancel();
    }
    for (const listener of this._listeners.get(sessionId) ?? []) listener();
    if (pending) this._telemetry.frameNotified(pending);
  }
}

function buildTranscript(state: ConversationState): Message[] {
  const entries = [...state.entries, ...state.pendingSubmissions.values()];
  return buildMessages(entries.map((entry) => ({
    entryId: entry.id,
    parentEntryId: entry.parentId,
    renderKey: entry.clientId
      ? `submission-${entry.clientId}`
      : entry.id!,
    message: entry.message,
  })));
}
