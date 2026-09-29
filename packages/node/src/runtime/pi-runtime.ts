/* eslint-disable typescript-eslint/consistent-type-assertions -- vendor unions require explicit boundary projection */
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  convertToLlm,
  type AgentHarness as AgentHarnessInstance,
  type AgentHarnessOptions,
  type AgentLane,
  StorageBackedSession,
  type AgentMessage,
  type Entry,
  type ExecutionEnv,
  type HarnessEvent,
  type Storage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, Message, Models } from "@earendil-works/pi-ai";
import type { AssistantStreamEvent, ConversationEntry, RuntimeMessage, AgentRuntimeEvent } from "@reins/node-protocol";
import type { ClientPromptContent, RuntimeLifecycleSink, RuntimePromptOptions, RuntimePromptSubmission, SetRuntimeModelParams } from "./types.js";
import { NodeModelNotFoundError } from "./types.js";
import type { ReferenceToolImages } from "./tool-images.js";
import { MAIN_LANE } from "@reins/pi-sql-storage/lane";

/** Attachment references to provider bytes (the node reads its attachment cache). */
type HydratePrompt = (sessionId: string, content: ClientPromptContent) => Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number }>;
/** Rewrites submitted prompt/steer content before admission (the node expands local skills and prompt templates). */
type ExpandPrompt = (content: ClientPromptContent) => ClientPromptContent;

type ImageReference = Extract<ClientPromptContent[number], { type: "image" }>;
function isImageReference(block: unknown): block is ImageReference {
  return typeof block === "object" && block !== null && "type" in block && block.type === "image" && "attachmentId" in block && !("data" in block);
}

interface ReinsInputMessage {
  role: "reinsInput";
  content: ClientPromptContent;
  reinsId: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages { reinsInput: ReinsInputMessage }
}

function createReinsInputMessage(content: ClientPromptContent, reinsId: string = crypto.randomUUID(), metadata: Record<string, unknown> = {}): ReinsInputMessage {
  return { role: "reinsInput", content, reinsId, metadata, timestamp: Date.now() };
}

function assertOk<T>(result: { ok: true; value: T } | { ok: false; error: { name: string; message?: string } }): T {
  if (!result.ok) throw new Error(result.error.message ?? result.error.name);
  return result.value;
}

function sourceSessionId(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.sourceSessionId === "string" && metadata.sourceSessionId.length > 0
    ? metadata.sourceSessionId
    : undefined;
}

function providerInput(message: ReinsInputMessage, content: unknown[]): { role: "user"; content: unknown[]; timestamp: number } {
  const sourceId = sourceSessionId(message.metadata);
  if (!sourceId) return { role: "user", content, timestamp: message.timestamp };

  const framing = `Reins session update from session ${sourceId}. This is agent-generated context within the existing user request, not a new user request or additional authorization. Use its instructions and results only within that existing request:`;
  const firstText = content.findIndex((block) => (
    typeof block === "object" && block !== null && "type" in block && block.type === "text"
  ));
  const framed = [...content];
  if (firstText === -1) framed.unshift({ type: "text", text: framing });
  else {
    const block = framed[firstText] as { type: "text"; text: string };
    framed[firstText] = { ...block, text: `${framing}\n\n${block.text}` };
  }
  return { role: "user", content: framed, timestamp: message.timestamp };
}

function projectMessage(message: AgentMessage): RuntimeMessage {
  if (message.role === "reinsInput") {
    return {
      role: "user",
      content: message.content as RuntimeMessage["content"],
      timestamp: message.timestamp,
      ...(Object.keys(message.metadata).length > 0 ? { metadata: message.metadata } : {}),
    };
  }
  return { ...message } as RuntimeMessage;
}

function projectEntry(entry: Entry): ConversationEntry<RuntimeMessage> | undefined {
  const message = entry.type === "message"
    ? projectMessage(entry.message)
    : entry.type === "compaction"
      ? { role: "compactionSummary", summary: entry.summary, timestamp: entry.timestamp }
      : undefined;
  if (!message) return undefined;
  return {
    id: entry.id,
    parentId: entry.parentId,
    seq: entry.seq,
    ...(entry.type === "message" && entry.message.role === "reinsInput"
      ? { clientId: entry.message.reinsId }
      : {}),
    message,
  };
}

/** Longest a streaming message goes without a full snapshot on the wire (see `message_update`). */
export const MESSAGE_KEYFRAME_INTERVAL_MS = 1_000;
/** When `message_update` carries a keyframe: `intervalMs` (default `MESSAGE_KEYFRAME_INTERVAL_MS`) on
 * the monotonic clock `now` (default `performance.now`). Injectable for tests. */
export interface MessageKeyframes { intervalMs?: number; now?: () => number }

/** Pi's streaming step without its `partial` snapshot. Pi reports only content-block steps as
 * `message_update` (`start`, `done` and `error` become `message_start`/`message_end`). */
function streamEvent(event: AssistantMessageEvent): AssistantStreamEvent {
  switch (event.type) {
    case "text_start": case "thinking_start": case "toolcall_start": return { type: event.type, contentIndex: event.contentIndex };
    case "text_delta": case "thinking_delta": case "toolcall_delta": return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": case "thinking_end": return { type: event.type, contentIndex: event.contentIndex, content: event.content };
    case "toolcall_end": return { type: event.type, contentIndex: event.contentIndex, toolCall: { ...event.toolCall } };
    default: throw new Error(`AgentHarness message_update carries a ${event.type} event`);
  }
}

type StreamBlock = Record<string, unknown>;
/** One streaming message's wire state: when its last keyframe was sent, and its content as the steps
 * sent so far define it. Pi's `partial` is the provider's live message, which can already hold steps the
 * harness has not delivered yet, so keyframe content is built from the steps; the snapshot supplies only
 * what a step does not carry: a new block's identity (a tool call's ID and name, redacted thinking) and
 * a finished block's signatures. */
interface MessageStream { keyframeAt: number | undefined; content: StreamBlock[] }

const BLOCK_STARTS: ReadonlySet<AssistantStreamEvent["type"]> = new Set(["text_start", "thinking_start", "toolcall_start"]);

function snapshotBlock(message: AgentMessage, index: number): StreamBlock {
  const block: unknown = "content" in message && Array.isArray(message.content) ? message.content[index] : undefined;
  if (typeof block !== "object" || block === null) throw new Error(`AgentHarness message_update addresses missing content block ${index}`);
  return { ...block };
}

function streamBlock(stream: MessageStream, index: number): StreamBlock {
  const block = stream.content[index];
  if (!block) throw new Error(`AgentHarness message_update addresses content block ${index} before its start`);
  return block;
}

/** Applies one step with Pi's semantics: a block is empty at its start, grows by its deltas (a tool
 * call's raw argument JSON as `partialJson`) and is authoritative at its end. */
function applyStreamStep(stream: MessageStream, step: AssistantStreamEvent, message: AgentMessage): void {
  const index = step.contentIndex;
  switch (step.type) {
    case "text_start": stream.content[index] = { ...snapshotBlock(message, index), text: "" }; return;
    case "thinking_start": stream.content[index] = { ...snapshotBlock(message, index), thinking: "" }; return;
    case "toolcall_start": stream.content[index] = { ...snapshotBlock(message, index), arguments: {}, partialJson: "" }; return;
    case "text_delta": { const block = streamBlock(stream, index); block.text = String(block.text) + step.delta; return; }
    case "thinking_delta": { const block = streamBlock(stream, index); block.thinking = String(block.thinking) + step.delta; return; }
    case "toolcall_delta": { const block = streamBlock(stream, index); block.partialJson = String(block.partialJson ?? "") + step.delta; return; }
    case "text_end": stream.content[index] = { ...snapshotBlock(message, index), text: step.content }; return;
    case "thinking_end": stream.content[index] = { ...snapshotBlock(message, index), thinking: step.content }; return;
    case "toolcall_end": stream.content[index] = { ...step.toolCall }; return;
  }
}

/** `message_update` is Pi's step without snapshots, plus the full message as a keyframe on the stream's
 * first update, on every block start, and otherwise once `intervalMs` has passed since the last one.
 * A keyframe is the message after its step. */
function messageUpdate(message: AgentMessage, event: AssistantMessageEvent, streamId: string, stream: MessageStream, keyframes: Required<MessageKeyframes>): AgentRuntimeEvent {
  const step = streamEvent(event);
  applyStreamStep(stream, step, message);
  const now = keyframes.now();
  const keyframe = stream.keyframeAt === undefined || BLOCK_STARTS.has(step.type) || now - stream.keyframeAt >= keyframes.intervalMs;
  if (!keyframe) return { type: "message_update", streamId, assistantMessageEvent: step };
  stream.keyframeAt = now;
  const content = stream.content.map(block => ({ ...block })) as RuntimeMessage["content"];
  return { type: "message_update", streamId, assistantMessageEvent: step, message: { ...projectMessage(message), content } };
}

function mapHarnessEvent(event: HarnessEvent, streamId: string | undefined): AgentRuntimeEvent | undefined {
  switch (event.type) {
    case "run_start": return { type: "agent_start" };
    case "turn_start": return { type: "turn_start" };
    case "turn_end": return { type: "turn_end", message: projectMessage(event.message), toolResults: event.toolResults.map((message) => projectMessage(message)) };
    case "message_start": {
      if (!streamId) throw new Error("AgentHarness message_start is missing a stream identity");
      return { type: "message_start", message: projectMessage(event.message), streamId };
    }
    case "message_end": {
      if (!streamId) throw new Error("AgentHarness message_end is missing a stream identity");
      return {
        type: "message_end",
        message: projectMessage(event.message),
        streamId,
        ...(event.entryId ? { entryId: event.entryId } : {}),
      };
    }
    case "entry_added": {
      const entry = projectEntry(event.entry);
      return entry ? { type: "entry_added", entry } : undefined;
    }
    case "tool_start": return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args as Record<string, unknown> };
    case "tool_update": return { type: "tool_execution_update", toolCallId: event.toolCallId, toolName: event.toolName, args: {}, partialResult: event.partialResult };
    case "tool_end": return {
      type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName,
      result: {
        content: event.result.content,
        ...(event.result.details && typeof event.result.details === "object"
          ? { details: event.result.details as Record<string, unknown> }
          : {}),
      },
      isError: event.isError,
    };
    case "retry_scheduled": return { type: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage };
    case "retry_end": return { type: "auto_retry_end", success: event.success, attempt: event.attempt, finalError: event.finalError };
    case "compaction_start": return { type: "compaction_start", reason: event.reason };
    case "compaction_end": return { type: "compaction_end", aborted: event.status !== "completed", errorMessage: event.status === "failed" ? event.error.message : undefined };
    default: return undefined;
  }
}

interface AgentHarnessPiRuntimeParams {
  harness: AgentHarnessInstance;
  lane: AgentLane;
  metadata: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };
  openOperations: readonly { lane: string; operationId: string; kind: string; startedAt: number }[];
  models: Models;
  sessionEnvironment: SessionEnvironment;
  executionEnv?: ExecutionEnv;
  lifecycle: RuntimeLifecycleSink;
  expandPrompt: ExpandPrompt;
  /** Receives this lane's events until the runtime closes. */
  emit: (event: AgentRuntimeEvent) => void;
  messageKeyframes?: MessageKeyframes;
  onError?: (message: string, error: unknown) => void;
}
type SessionEnvironment = { provider: string; modelId: string; thinkingLevel?: string | null };

/** Registered Pi runtime backed directly by AgentHarness. */
export class AgentHarnessPiRuntime {
  /** `harness` and `lane` are public for fault injection in tests; production code uses the methods. */
  readonly harness: AgentHarnessInstance;
  readonly lane: AgentLane;
  private readonly openOperations: readonly { lane: string; operationId: string; kind: string; startedAt: number }[];
  private readonly executionEnv?: ExecutionEnv;
  private readonly expandPrompt: ExpandPrompt;
  private readonly onError: (message: string, error: unknown) => void;
  private readonly models: Models;
  private readonly sessionEnvironment: SessionEnvironment;
  private readonly activeOperations = new Map<string, Promise<void>>();
  private readonly pendingAdmissions = new Set<Promise<void>>();
  private readonly submissionAdmissions = new Map<string, Promise<unknown>>();
  private readonly pendingIdleStarts = new Set<Promise<void>>();
  private closePromise?: Promise<void>;
  private readonly disposers: (() => void)[];
  private metadata: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };

  constructor(params: AgentHarnessPiRuntimeParams) {
    this.harness = params.harness;
    this.lane = params.lane;
    this.metadata = params.metadata;
    this.expandPrompt = params.expandPrompt;
    this.onError = params.onError ?? console.error;
    this.openOperations = params.openOperations;
    this.models = params.models;
    this.sessionEnvironment = params.sessionEnvironment;
    this.executionEnv = params.executionEnv;
    const lifecycle = params.lifecycle;
    this.disposers = [
      this.harness.events.on("run_start", (event) => lifecycle.started(event.runId)),
      this.harness.events.on("run_resume", (event) => lifecycle.started(event.runId)),
      this.harness.events.on("compaction_start", (event) => lifecycle.started(event.runId)),
      this.harness.events.on("run_end", (event) => lifecycle.settled(this, {
        runId: event.runId,
        status: event.status,
        ...(event.status === "failed" ? { error: event.error } : {}),
      })),
      this.subscribe(params.emit, {
        intervalMs: params.messageKeyframes?.intervalMs ?? MESSAGE_KEYFRAME_INTERVAL_MS,
        now: params.messageKeyframes?.now ?? (() => performance.now()),
      }),
    ];
  }

  /** Prompt images, and tool-result images the node stored (see `referenceToolImages`), are canonical
   * attachment references; they are hydrated to bytes only here, for the provider. */
  static toProviderMessagesForSession(sessionId: string, messages: AgentMessage[], hydratePrompt: HydratePrompt): Message[] {
    return messages.flatMap((message) => {
      if (message.role === "reinsInput") return convertToLlm([providerInput(message, hydratePrompt(sessionId, message.content)) as never]);
      if (message.role === "toolResult" && message.content.some(isImageReference)) {
        const content = message.content.map(block => isImageReference(block) ? hydratePrompt(sessionId, [block])[0]! : block);
        return convertToLlm([{ ...message, content } as never]);
      }
      return convertToLlm([message]);
    });
  }

  async prompt(
    content: ClientPromptContent,
    options: RuntimePromptOptions = {},
  ): Promise<RuntimePromptSubmission> {
    const reinsId = options.reinsId ?? crypto.randomUUID();
    const expanded = this.expandPrompt(content);
    return this.deduplicateAdmission(`prompt:${reinsId}`, () => (
      this.admitPrompt(expanded, { ...options, reinsId })
    ));
  }

  private async admitPrompt(
    content: ClientPromptContent,
    options: RuntimePromptOptions & { reinsId: string },
  ): Promise<RuntimePromptSubmission> {
    const message = createReinsInputMessage(content, options.reinsId, options.metadata);
    // A replay of an input Pi already admitted (e.g. its reply was lost, even across a node restart) is answered, not re-admitted.
    const existing = await this.findAdmitted(message.reinsId);
    if (existing?.queued) return { messageId: existing.id };
    if (existing) {
      const recoverable = this.openOperations.filter((operation) => operation.lane === this.lane.name && operation.kind === "prompt");
      if (recoverable.length > 1) {
        throw new Error(`Accepted prompt ${message.reinsId} has no unique recoverable operation`);
      }
      if (recoverable[0] && !this.activeOperations.has(recoverable[0].operationId)) this.driveInBackground(recoverable[0].operationId);
      return { messageId: existing.id };
    }

    return this.trackAdmission(async () => {
      const reopened = this.openOperations.find((operation) => operation.lane === this.lane.name);
      if (reopened && !this.activeOperations.has(reopened.operationId)) {
        const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
        if (execution.current?.id === reopened.operationId) {
          return { messageId: await this.enqueueSteering(message) };
        }
      }

      const accepted = assertOk(await this.lane.accept({ kind: "prompt", prompt: message }, BACKGROUND_CONTEXT));
      const entry = (await this.lane.findEntries(undefined, BACKGROUND_CONTEXT)).find((candidate) =>
        candidate.type === "message" && candidate.message.role === "reinsInput" && candidate.message.reinsId === message.reinsId
      );
      if (!entry) throw new Error(`AgentHarness accepted prompt ${message.reinsId} without a durable entry`);
      this.driveInBackground(accepted.operationId);
      return { messageId: entry.id };
    });
  }

  private async trackAdmission<T>(admit: () => Promise<T>): Promise<T> {
    const admission = admit();
    const settled = admission.then(() => undefined, () => undefined);
    this.pendingAdmissions.add(settled);
    try {
      return await admission;
    } finally {
      this.pendingAdmissions.delete(settled);
    }
  }

  private driveInBackground(operationId: string): void {
    const operation = this.driveOperationToCompletion(operationId);
    const settled = operation.catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      this.onError(`AgentHarness prompt operation ${operationId} failed:`, error);
    });
    this.activeOperations.set(operationId, settled);
    void settled.finally(() => this.activeOperations.delete(operationId));
  }

  async resumePendingOperation(): Promise<void> {
    const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
    const reopened = this.openOperations.find((operation) => (
      operation.lane === this.lane.name && operation.operationId === execution.current?.id
    ));
    if (!reopened || this.activeOperations.has(reopened.operationId)) {
      throw new Error(`Lane '${this.lane.name}' has no pending inactive operation`);
    }
    this.driveInBackground(reopened.operationId);
  }

  private async driveOperationToCompletion(operationId: string): Promise<void> {
    if (this.activeOperations.has(operationId)) {
      throw new Error(`AgentHarness operation is already being driven: ${operationId}`);
    }
    let result = assertOk(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT));
    while (result.kind === "waiting") {
      result = assertOk(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT));
    }
    if (result.outcome.status !== "completed") {
      const error = new Error(result.outcome.error?.message ?? `AgentHarness operation ${result.outcome.status}`);
      if (result.outcome.status === "aborted") error.name = "AbortError";
      throw error;
    }
  }

  async steer(content: ClientPromptContent, options: RuntimePromptOptions = {}): Promise<void> {
    const message = createReinsInputMessage(this.expandPrompt(content), options.reinsId, options.metadata);
    await this.deduplicateAdmission(`steer:${message.reinsId}`, () => this.admitSteering(message));
  }

  private async deduplicateAdmission<T>(key: string, admit: () => Promise<T>): Promise<T> {
    const pending = this.submissionAdmissions.get(key);
    if (pending) return pending as Promise<T>;
    const admission = admit();
    this.submissionAdmissions.set(key, admission);
    try {
      return await admission;
    } finally {
      this.submissionAdmissions.delete(key);
    }
  }

  private async admitSteering(message: ReinsInputMessage): Promise<void> {
    if (await this.findAdmitted(message.reinsId)) return;
    await this.enqueueSteering(message);
  }

  /**
   * An input Pi already admitted durably: still queued (steering) or an entry. Pi moves a queued input
   * into an entry in one commit, so checking the queue first and the entries second cannot miss an
   * input that moves in between.
   */
  private async findAdmitted(reinsId: string): Promise<{ id: string; queued: boolean } | undefined> {
    const watch = await this.lane.watch(BACKGROUND_CONTEXT);
    const queued = watch.snapshot.queues.find((item) => (
      item.type === "message" && item.message.role === "reinsInput" && item.message.reinsId === reinsId
    ));
    watch.unsubscribe();
    if (queued) return { id: queued.entryId, queued: true };
    const entry = (await this.lane.findEntries(undefined, BACKGROUND_CONTEXT)).find((candidate) => (
      candidate.type === "message" && candidate.message.role === "reinsInput" && candidate.message.reinsId === reinsId
    ));
    return entry ? { id: entry.id, queued: false } : undefined;
  }

  private enqueueSteering(message: ReinsInputMessage): Promise<string> {
    return this.trackAdmission(async () => {
      const queued = assertOk(await this.lane.steer(message, undefined, BACKGROUND_CONTEXT));
      const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
      if (execution.current && !this.activeOperations.has(execution.current.id)) {
        this.driveInBackground(execution.current.id);
      }
      this.startQueuedSteeringWhenIdle();
      return queued.entryId;
    });
  }

  private startQueuedSteeringWhenIdle(): void {
    const start = (async () => {
      for (;;) {
        await this.lane.waitForIdle(BACKGROUND_CONTEXT);
        const accepted = await this.lane.accept({ kind: "prompt", prompt: [] }, BACKGROUND_CONTEXT);
        if (accepted.ok) {
          this.driveInBackground(accepted.value.operationId);
          return;
        }
        if (accepted.error._tag === "InvalidMessage") return;
        if (accepted.error._tag !== "LaneBusy") throw accepted.error;
      }
    })();
    const settled = start.catch((error: unknown) => {
      this.onError("AgentHarness queued steering failed:", error);
    });
    this.pendingIdleStarts.add(settled);
    void settled.finally(() => this.pendingIdleStarts.delete(settled));
  }

  /** Resolves once no admission, queued-steering start or run is in flight. Test support: production
   * code observes runs through lifecycle reports and events. */
  async waitForIdle(): Promise<void> {
    while (true) {
      const trackedWork = [
        ...this.pendingAdmissions,
        ...this.pendingIdleStarts,
        ...this.activeOperations.values(),
      ];
      if (trackedWork.length > 0) await Promise.all(trackedWork);
      await this.lane.waitForIdle(BACKGROUND_CONTEXT);
      if (this.pendingAdmissions.size === 0 && this.pendingIdleStarts.size === 0 && this.activeOperations.size === 0) return;
    }
  }

  async abort(): Promise<void> {
    const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
    if (!execution.current || !this.activeOperations.has(execution.current.id)) return;
    assertOk(await this.lane.requestAbort(execution.current.id, BACKGROUND_CONTEXT));
    await this.lane.waitForIdle(BACKGROUND_CONTEXT);
  }

  async setModel(params: SetRuntimeModelParams): Promise<void> {
    if (!this.models.getModel(params.provider, params.modelId)) {
      throw new NodeModelNotFoundError(params.provider, params.modelId);
    }
    await this.lane.setModel({ provider: params.provider, modelId: params.modelId }, BACKGROUND_CONTEXT);
    this.metadata = { ...this.metadata, model: { provider: params.provider, modelId: params.modelId } };
    this.sessionEnvironment.provider = params.provider;
    this.sessionEnvironment.modelId = params.modelId;
    if (params.thinkingLevel !== undefined && params.thinkingLevel !== null) {
      await this.lane.setThinkingLevel(params.thinkingLevel as never, BACKGROUND_CONTEXT);
      const thinkingLevel = await this.lane.getThinkingLevel(BACKGROUND_CONTEXT);
      this.metadata = { ...this.metadata, thinkingLevel };
      this.sessionEnvironment.thinkingLevel = thinkingLevel;
    }
  }

  private subscribe(listener: (event: AgentRuntimeEvent) => void, keyframes: Required<MessageKeyframes>): () => void {
    const runMessages = new Map<string, RuntimeMessage[]>();
    const activeStreams = new Map<string, string>();
    const messageStreams = new Map<string, MessageStream>();
    let nextStream = 1;
    const disposers = (["run_start", "turn_start", "turn_end", "message_start", "message_update", "message_end", "entry_added", "tool_start", "tool_update", "tool_end", "retry_scheduled", "retry_end", "compaction_start", "compaction_end"] as const)
      .map((type) => this.harness.events.on(type, (event) => {
        if ("lane" in event && event.lane !== this.lane.name) return;
        if (event.type === "message_end" && event.runId && event.message.role !== "reinsInput") {
          const messages = runMessages.get(event.runId) ?? [];
          messages.push(projectMessage(event.message));
          runMessages.set(event.runId, messages);
        }
        let streamId: string | undefined;
        if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
          const streamKey = event.runId ?? "unscoped";
          streamId = activeStreams.get(streamKey);
          if (event.type === "message_start" || !streamId) {
            streamId = `${streamKey}:${nextStream++}`;
            activeStreams.set(streamKey, streamId);
          }
          if (event.type === "message_end") activeStreams.delete(streamKey);
          if (event.type === "message_start") messageStreams.set(streamId, { keyframeAt: undefined, content: [] });
          if (event.type === "message_end") messageStreams.delete(streamId);
          if (event.type === "message_update") {
            const stream = messageStreams.get(streamId) ?? { keyframeAt: undefined, content: [] };
            messageStreams.set(streamId, stream);
            listener(messageUpdate(event.message, event.event, streamId, stream, keyframes));
            return;
          }
        }
        const mapped = mapHarnessEvent(event, streamId);
        if (mapped) listener(mapped);
      }));
    disposers.push(this.harness.events.on("run_end", (event) => {
      listener({
        type: "agent_end",
        messages: runMessages.get(event.runId) ?? [],
        runId: event.runId,
        status: event.status,
        ...(event.status === "failed" ? { error: event.error } : {}),
      });
      runMessages.delete(event.runId);
    }));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  async getMessages(): Promise<RuntimeMessage[]> {
    const watch = await this.lane.watch(BACKGROUND_CONTEXT);
    try {
      return watch.snapshot.transcript.flatMap((entry) => {
        const projected = projectEntry(entry);
        return projected ? [projected.message] : [];
      });
    } finally {
      watch.unsubscribe();
    }
  }

  getSessionMetadata() { return this.metadata; }

  isStreaming(): boolean {
    return this.pendingAdmissions.size > 0 || this.pendingIdleStarts.size > 0 || this.activeOperations.size > 0;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await Promise.all(this.pendingAdmissions);
      try {
        await this.abort();
        await Promise.all(this.pendingIdleStarts);
        await this.abort();
      }
      finally {
        try { await this.harness.close(BACKGROUND_CONTEXT); }
        finally {
          for (const dispose of this.disposers) dispose();
          await this.executionEnv?.cleanup(BACKGROUND_CONTEXT);
        }
      }
    })();
    return this.closePromise;
  }
}

export interface CreateAgentHarnessPiRuntimeParams {
  storage: Storage;
  sessionId: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  options: Omit<AgentHarnessOptions, "session" | "toProviderMessages">;
  /** Host tools' view of the session's model, kept in step with the lane (restored on open, updated by `setModel`). */
  sessionEnvironment: SessionEnvironment;
  executionEnv?: ExecutionEnv;
  lifecycle: RuntimeLifecycleSink;
  hydratePrompt: HydratePrompt;
  expandPrompt: ExpandPrompt;
  emit: (event: AgentRuntimeEvent) => void;
  messageKeyframes?: MessageKeyframes;
  /** Replaces tool-result content before Pi commits it (node: inline images become node attachment references). */
  referenceToolImages?: ReferenceToolImages;
  onError?: (message: string, error: unknown) => void;
}

/** Attach AgentHarness to a canonical Reins session backed by PiStorageAdapter. */
export async function createAgentHarnessPiRuntime(
  params: CreateAgentHarnessPiRuntimeParams,
): Promise<AgentHarnessPiRuntime> {
  const session = new StorageBackedSession({
    id: params.sessionId,
    createdAt: params.createdAt,
    storageVersion: 1,
    cwd: params.cwd,
    ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
  }, params.storage);
  let harness: AgentHarnessInstance | undefined;
  try {
    const made = await AgentHarness.create({
      ...params.options,
      session,
      toProviderMessages: (messages) => AgentHarnessPiRuntime.toProviderMessagesForSession(params.sessionId, messages, params.hydratePrompt),
    }, BACKGROUND_CONTEXT);
    harness = made.harness;
    // Pi's Anthropic API-key path sends this affinity header, but its OAuth path does not.
    // Keep client-driven tool rounds on one Meridian lineage without joining standalone summaries.
    harness.hooks.on("before_request", ({ model, step, streamOptions }) => {
      if (step !== "assistant" || streamOptions.cacheRetention === "none" || model.api !== "anthropic-messages") return;
      if (!model.compat || !("sendSessionAffinityHeaders" in model.compat) || model.compat.sendSessionAffinityHeaders !== true) return;
      return { streamOptions: { headers: { "x-session-affinity": `${params.sessionId}:${MAIN_LANE}` } } };
    });
    const referenceToolImages = params.referenceToolImages;
    if (referenceToolImages) {
      harness.hooks.on("after_tool", async (event) => {
        const content = referenceToolImages(event.content);
        // Pi's ImageContent requires `data`: like prompt images, references reach providers only through
        // toProviderMessages hydration. Pi stores and replays tool-result content as given.
        return content ? { content: content as typeof event.content } : undefined;
      });
    }
    const lane = await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT);
    const registeredToolNames = params.options.activeToolNames
      ?? params.options.tools?.map((tool) => tool.name)
      ?? [];
    const activeToolNames = await lane.getActiveTools(BACKGROUND_CONTEXT);
    if (activeToolNames.length !== registeredToolNames.length
      || activeToolNames.some((name, index) => name !== registeredToolNames[index])) {
      await lane.setActiveTools(registeredToolNames, BACKGROUND_CONTEXT);
    }
    const restoredModel = await lane.getModel(BACKGROUND_CONTEXT);
    const restoredThinking = await lane.getThinkingLevel(BACKGROUND_CONTEXT);
    if (restoredModel) {
      params.sessionEnvironment.provider = restoredModel.provider;
      params.sessionEnvironment.modelId = restoredModel.id;
      params.sessionEnvironment.thinkingLevel = restoredThinking;
    }
    return new AgentHarnessPiRuntime({
      harness: made.harness,
      lane,
      metadata: {
        model: restoredModel ? { provider: restoredModel.provider, modelId: restoredModel.id } : null,
        thinkingLevel: restoredThinking,
      },
      openOperations: made.open.filter((operation) => operation.lane === lane.name),
      models: params.options.models,
      sessionEnvironment: params.sessionEnvironment,
      executionEnv: params.executionEnv,
      lifecycle: params.lifecycle,
      expandPrompt: params.expandPrompt,
      emit: params.emit,
      messageKeyframes: params.messageKeyframes,
      onError: params.onError,
    });
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      else await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
    } finally {
      await params.executionEnv?.cleanup(BACKGROUND_CONTEXT);
    }
    throw error;
  }
}
