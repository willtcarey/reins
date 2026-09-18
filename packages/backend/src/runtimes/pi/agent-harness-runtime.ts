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
} from "@earendil-works/pi-agent-core";
import type { Database } from "bun:sqlite";
import type { Message, Models } from "@earendil-works/pi-ai";
import { hydratePromptContent } from "../../session-attachments-store.js";
import type { ClientPromptContent, RuntimeMessage } from "../../messages-store.js";
import { logger } from "../../logger.js";
import type { AgentRuntime, AgentRuntimeEvent, RuntimeLifecycleSink, RuntimePromptOptions, RuntimePromptSubmission, RuntimeRunOutcome, SetRuntimeModelParams } from "../registry.js";
import { PiStorageAdapter } from "./storage-adapter.js";

export interface ReinsInputMessage {
  role: "reinsInput";
  content: ClientPromptContent;
  reinsId: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages { reinsInput: ReinsInputMessage }
}

export function createReinsInputMessage(
  content: ClientPromptContent,
  reinsId: string = crypto.randomUUID(),
  metadata: Record<string, unknown> = {},
  timestamp = Date.now(),
): ReinsInputMessage {
  return { role: "reinsInput", content, reinsId, metadata, timestamp };
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

function projectMessage(message: AgentMessage, logicalId?: string): RuntimeMessage {
  if (message.role === "reinsInput") {
    return {
      role: "user",
      content: message.content as RuntimeMessage["content"],
      timestamp: message.timestamp,
      ...(Object.keys(message.metadata).length > 0 ? { metadata: message.metadata } : {}),
      ...(logicalId ? { logicalId } : {}),
    };
  }
  return { ...message, ...(logicalId ? { logicalId } : {}) } as RuntimeMessage;
}

function projectEntry(entry: Entry): RuntimeMessage | undefined {
  if (entry.type === "message") return projectMessage(entry.message, entry.id);
  if (entry.type === "compaction") {
    return { role: "compactionSummary", summary: entry.summary, logicalId: entry.id };
  }
  return undefined;
}

function mapHarnessEvent(event: HarnessEvent): AgentRuntimeEvent | undefined {
  switch (event.type) {
    case "run_start": return { type: "agent_start" };
    case "turn_start": return { type: "turn_start" };
    case "turn_end": return { type: "turn_end", message: projectMessage(event.message), toolResults: event.toolResults.map((message) => projectMessage(message)) };
    case "message_start": return { type: "message_start", message: projectMessage(event.message) };
    case "message_update": return { type: "message_update", message: projectMessage(event.message), assistantMessageEvent: event.event };
    case "message_end": return { type: "message_end", message: projectMessage(event.message, event.entryId) };
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

export interface AgentHarnessPiRuntimeParams {
  harness: AgentHarnessInstance;
  lane: AgentLane;
  metadata?: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };
  sessionId?: string;
  openOperations?: readonly { lane: string; operationId: string; kind: string; startedAt: number }[];
  models?: Models;
  sessionEnvironment?: { provider: string; modelId: string; thinkingLevel?: string | null };
  executionEnv?: ExecutionEnv;
  lifecycle?: RuntimeLifecycleSink;
}

/** Registered Pi runtime backed directly by AgentHarness. */
export class AgentHarnessPiRuntime implements AgentRuntime {
  readonly harness: AgentHarnessInstance;
  readonly lane: AgentLane;
  private readonly openOperations: readonly { lane: string; operationId: string; kind: string; startedAt: number }[];
  private readonly executionEnv?: ExecutionEnv;
  private readonly sessionId?: string;
  private readonly models?: Models;
  private readonly sessionEnvironment?: { provider: string; modelId: string; thinkingLevel?: string | null };
  private readonly activeOperations = new Map<string, Promise<void>>();
  private readonly pendingAdmissions = new Set<Promise<void>>();
  private readonly pendingIdleStarts = new Set<Promise<void>>();
  private closePromise?: Promise<void>;
  private readonly lifecycleDisposers: (() => void)[];
  private metadata: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };

  constructor(params: AgentHarnessPiRuntimeParams) {
    this.harness = params.harness;
    this.lane = params.lane;
    this.metadata = params.metadata ?? {};
    this.sessionId = params.sessionId;
    this.openOperations = params.openOperations ?? [];
    this.models = params.models;
    this.sessionEnvironment = params.sessionEnvironment;
    this.executionEnv = params.executionEnv;
    const lifecycle = params.lifecycle;
    this.lifecycleDisposers = lifecycle ? [
      this.harness.events.on("run_start", () => lifecycle.started()),
      this.harness.events.on("run_resume", () => lifecycle.started()),
      this.harness.events.on("compaction_start", () => lifecycle.started()),
      this.harness.events.on("run_end", (event) => lifecycle.settled(this, {
        runId: event.runId,
        status: event.status,
        ...(event.status === "failed" ? { error: event.error } : {}),
      })),
    ] : [];
  }

  static toProviderMessagesForSession(sessionId: string, messages: AgentMessage[]): Message[] {
    return messages.flatMap((message) => message.role === "reinsInput"
      ? convertToLlm([providerInput(message, hydratePromptContent(sessionId, message.content)) as never])
      : convertToLlm([message]));
  }

  async prompt(
    content: ClientPromptContent,
    options: RuntimePromptOptions = {},
  ): Promise<RuntimePromptSubmission> {
    if (!this.sessionId && content.some((block) => block.type === "image")) {
      throw new Error("Cannot hydrate prompt attachments without a Reins session id");
    }
    const message = createReinsInputMessage(content, options.reinsId, options.metadata, options.timestamp);
    const existing = (await this.lane.findEntries(undefined, BACKGROUND_CONTEXT)).find((entry) =>
      entry.type === "message" && entry.message.role === "reinsInput" && entry.message.reinsId === message.reinsId
    );
    if (existing) {
      const recoverable = this.openOperations.filter((operation) => operation.lane === this.lane.name && operation.kind === "prompt");
      if (recoverable.length > 1) {
        throw new Error(`Accepted prompt ${message.reinsId} has no unique recoverable operation`);
      }
      if (recoverable[0]) this.driveInBackground(recoverable[0].operationId);
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
      logger.error(`AgentHarness prompt operation ${operationId} failed:`, error);
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
    await this.enqueueSteering(createReinsInputMessage(
      content,
      options.reinsId,
      options.metadata,
      options.timestamp,
    ));
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
      logger.error("AgentHarness queued steering failed:", error);
    });
    this.pendingIdleStarts.add(settled);
    void settled.finally(() => this.pendingIdleStarts.delete(settled));
  }

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
    if (this.models && !this.models.getModel(params.provider, params.modelId)) {
      throw new Error(`Model not found: ${params.provider}/${params.modelId}`);
    }
    await this.lane.setModel({ provider: params.provider, modelId: params.modelId }, BACKGROUND_CONTEXT);
    this.metadata = { ...this.metadata, model: { provider: params.provider, modelId: params.modelId } };
    if (this.sessionEnvironment) {
      this.sessionEnvironment.provider = params.provider;
      this.sessionEnvironment.modelId = params.modelId;
    }
    if (params.thinkingLevel !== undefined && params.thinkingLevel !== null) {
      await this.lane.setThinkingLevel(params.thinkingLevel as never, BACKGROUND_CONTEXT);
      const thinkingLevel = await this.lane.getThinkingLevel(BACKGROUND_CONTEXT);
      this.metadata = { ...this.metadata, thinkingLevel };
      if (this.sessionEnvironment) this.sessionEnvironment.thinkingLevel = thinkingLevel;
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    const runMessages = new Map<string, RuntimeMessage[]>();
    const disposers = (["run_start", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_start", "tool_update", "tool_end", "retry_scheduled", "retry_end", "compaction_start", "compaction_end"] as const)
      .map((type) => this.harness.events.on(type, (event) => {
        if (event.type === "turn_end") {
          const messages = runMessages.get(event.runId) ?? [];
          messages.push(projectMessage(event.message), ...event.toolResults.map((message) => projectMessage(message)));
          runMessages.set(event.runId, messages);
        }
        const mapped = mapHarnessEvent(event);
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
        return projected ? [projected] : [];
      });
    } finally {
      watch.unsubscribe();
    }
  }

  async getLastRunOutcome(): Promise<RuntimeRunOutcome | null> {
    const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
    if (!execution.lastOperationId) return null;
    const outcome = await this.lane.getResult(execution.lastOperationId, BACKGROUND_CONTEXT);
    if (!outcome) return null;
    return {
      runId: outcome.operationId,
      status: outcome.status === "declined" ? "failed" : outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
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
          for (const dispose of this.lifecycleDisposers) dispose();
          await this.executionEnv?.cleanup(BACKGROUND_CONTEXT);
        }
      }
    })();
    return this.closePromise;
  }
}

export interface CreateAgentHarnessPiRuntimeParams {
  db: Database;
  sessionId: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  options: Omit<AgentHarnessOptions, "session" | "toProviderMessages">;
  sessionEnvironment?: { provider: string; modelId: string; thinkingLevel?: string | null };
  executionEnv?: ExecutionEnv;
  lifecycle?: RuntimeLifecycleSink;
}

/** Attach AgentHarness to a canonical Reins session backed by PiStorageAdapter. */
export async function createAgentHarnessPiRuntime(
  params: CreateAgentHarnessPiRuntimeParams,
): Promise<AgentHarnessPiRuntime> {
  const storage = new PiStorageAdapter(params.db, params.sessionId);
  const session = new StorageBackedSession({
    id: params.sessionId,
    createdAt: params.createdAt,
    storageVersion: 1,
    cwd: params.cwd,
    ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
  }, storage);
  let harness: AgentHarnessInstance | undefined;
  try {
    const made = await AgentHarness.create({
      ...params.options,
      session,
      toProviderMessages: (messages) => AgentHarnessPiRuntime.toProviderMessagesForSession(params.sessionId, messages),
    }, BACKGROUND_CONTEXT);
    harness = made.harness;
    const lane = await harness.lane("main", BACKGROUND_CONTEXT);
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
    if (params.sessionEnvironment && restoredModel) {
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
      sessionId: params.sessionId,
      openOperations: made.open.filter((operation) => operation.lane === lane.name),
      models: params.options.models,
      sessionEnvironment: params.sessionEnvironment,
      executionEnv: params.executionEnv,
      lifecycle: params.lifecycle,
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
