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
import type { AgentRuntime, AgentRuntimeEvent, RuntimePromptOptions, RuntimePromptSubmission, RuntimeRunOutcome, SetRuntimeModelParams } from "../registry.js";
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
}

/** Registered Pi runtime backed directly by AgentHarness. */
export class AgentHarnessPiRuntime implements AgentRuntime {
  readonly harness: AgentHarnessInstance;
  readonly lane: AgentLane;
  readonly openOperations: readonly { lane: string; operationId: string; kind: string; startedAt: number }[];
  readonly executionEnv?: ExecutionEnv;
  private readonly sessionId?: string;
  private readonly models?: Models;
  private readonly sessionEnvironment?: { provider: string; modelId: string; thinkingLevel?: string | null };
  private readonly activeOperations = new Map<string, PromiseWithResolvers<void>>();
  private readonly pendingSubmissions = new Set<PromiseWithResolvers<void>>();
  private readonly pendingSteering = new Set<PromiseWithResolvers<void>>();
  private closePromise?: Promise<void>;
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
  }

  static toProviderMessages(messages: AgentMessage[]): Message[] {
    return messages.flatMap((message) => message.role === "reinsInput"
      ? convertToLlm([providerInput(message, message.content) as never])
      : convertToLlm([message]));
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

    const submission = Promise.withResolvers<void>();
    this.pendingSubmissions.add(submission);
    try {
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
    } finally {
      this.pendingSubmissions.delete(submission);
      submission.resolve();
    }
  }

  async promptMessage(message: ReinsInputMessage): Promise<RuntimePromptSubmission> {
    return this.prompt(message.content, {
      reinsId: message.reinsId,
      metadata: message.metadata,
      timestamp: message.timestamp,
    });
  }

  private driveInBackground(operationId: string): void {
    void this.driveOperationToCompletion(operationId).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      logger.error(`AgentHarness prompt operation ${operationId} failed:`, error);
    });
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

  /** Resume one returned open operation explicitly; construction does not execute open operations. */
  async resumeOpenOperation(operationId: string): Promise<void> {
    if (!this.openOperations.some((operation) => operation.lane === this.lane.name && operation.operationId === operationId)) {
      throw new Error(`Operation was not reopened on lane '${this.lane.name}': ${operationId}`);
    }
    await this.driveOperationToCompletion(operationId);
  }

  private async driveOperationToCompletion(operationId: string): Promise<void> {
    if (this.activeOperations.has(operationId)) {
      throw new Error(`AgentHarness operation is already being driven: ${operationId}`);
    }
    const completion = Promise.withResolvers<void>();
    this.activeOperations.set(operationId, completion);
    try {
      let result = assertOk(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT));
      while (result.kind === "waiting") {
        result = assertOk(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT));
      }
      if (result.outcome.status !== "completed") {
        const error = new Error(result.outcome.error?.message ?? `AgentHarness operation ${result.outcome.status}`);
        if (result.outcome.status === "aborted") error.name = "AbortError";
        throw error;
      }
    } finally {
      this.activeOperations.delete(operationId);
      completion.resolve();
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

  private async enqueueSteering(message: ReinsInputMessage): Promise<string> {
    const queued = assertOk(await this.lane.steer(message, undefined, BACKGROUND_CONTEXT));
    const pending = Promise.withResolvers<void>();
    this.pendingSteering.add(pending);
    try {
      const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
      if (execution.current && !this.activeOperations.has(execution.current.id)) {
        this.driveInBackground(execution.current.id);
      }
      void this.startQueuedSteeringWhenIdle(pending).catch((error: unknown) => {
        logger.error("AgentHarness queued steering failed:", error);
      });
      return queued.entryId;
    } catch (error) {
      this.pendingSteering.delete(pending);
      pending.resolve();
      throw error;
    }
  }

  private async startQueuedSteeringWhenIdle(pending: PromiseWithResolvers<void>): Promise<void> {
    try {
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
    } finally {
      this.pendingSteering.delete(pending);
      pending.resolve();
    }
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const trackedWork = [
        ...[...this.pendingSubmissions.values()].map((submission) => submission.promise),
        ...[...this.pendingSteering.values()].map((pending) => pending.promise),
        ...[...this.activeOperations.values()].map((completion) => completion.promise),
      ];
      if (trackedWork.length > 0) await Promise.all(trackedWork);
      await this.lane.waitForIdle(BACKGROUND_CONTEXT);
      if (this.pendingSubmissions.size === 0 && this.pendingSteering.size === 0 && this.activeOperations.size === 0) return;
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
    return this.pendingSubmissions.size > 0 || this.pendingSteering.size > 0 || this.activeOperations.size > 0;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await Promise.all([...this.pendingSubmissions].map((submission) => submission.promise));
      try {
        await this.abort();
        await Promise.all([...this.pendingSteering].map((pending) => pending.promise));
        await this.abort();
      }
      finally {
        try { await this.harness.close(BACKGROUND_CONTEXT); }
        finally { await this.executionEnv?.cleanup(BACKGROUND_CONTEXT); }
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
