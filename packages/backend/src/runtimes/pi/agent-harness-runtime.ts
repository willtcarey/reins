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
  type HarnessEvent,
  type LaneSnapshot,
  type WatchHandle,
} from "@earendil-works/pi-agent-core";
import type { Database } from "bun:sqlite";
import type { Message, Models } from "@earendil-works/pi-ai";
import { hydratePromptContent } from "../../session-attachments-store.js";
import type { ClientPromptContent, RuntimeMessage } from "../../messages-store.js";
import type { AgentRuntime, AgentRuntimeEvent, SetRuntimeModelParams } from "../registry.js";
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
  const value = result.value;
  if (value && typeof value === "object" && "status" in value) {
    const outcome = value as { status: string; error?: { message?: string } };
    if (outcome.status !== "completed" && outcome.status !== "suspended") {
      throw new Error(outcome.error?.message ?? `AgentHarness operation ${outcome.status}`);
    }
  }
  return value;
}

function projectMessage(message: AgentMessage, logicalId?: string): RuntimeMessage {
  if (message.role === "reinsInput") {
    return { role: "user", content: message.content as RuntimeMessage["content"], timestamp: message.timestamp, ...(logicalId ? { logicalId } : {}) };
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

/** Unselected next-generation Pi runtime backed directly by AgentHarness. */
export class AgentHarnessPiRuntime implements AgentRuntime {
  readonly runtimeType = "pi-agent-harness" as const;
  readonly activityCompletionBoundary = "agent_settled" as const;
  private readonly activeOperations = new Map<string, PromiseWithResolvers<void>>();
  private readonly pendingSubmissions = new Set<PromiseWithResolvers<void>>();
  private readonly runtimeListeners = new Set<(event: AgentRuntimeEvent) => void>();
  private closePromise?: Promise<void>;
  private metadata: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };

  constructor(
    readonly harness: AgentHarnessInstance,
    readonly lane: AgentLane,
    metadata: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null } = {},
    private readonly sessionId?: string,
    readonly openOperations: readonly { lane: string; operationId: string; kind: string; startedAt: number }[] = [],
    private readonly models?: Models,
    private readonly transcriptWatch?: WatchHandle<LaneSnapshot>,
    private readonly sessionEnvironment?: { provider: string; modelId: string; thinkingLevel?: string | null },
  ) {
    this.metadata = metadata;
    this.transcriptWatch?.start(() => undefined);
  }

  static toProviderMessages(messages: AgentMessage[]): Message[] {
    return messages.flatMap((message) => message.role === "reinsInput"
      ? convertToLlm([{ role: "user", content: message.content as never, timestamp: message.timestamp }])
      : convertToLlm([message]));
  }

  static toProviderMessagesForSession(sessionId: string, messages: AgentMessage[]): Message[] {
    return messages.flatMap((message) => message.role === "reinsInput"
      ? convertToLlm([{ role: "user", content: hydratePromptContent(sessionId, message.content), timestamp: message.timestamp }])
      : convertToLlm([message]));
  }

  async prompt(content: ClientPromptContent): Promise<void> {
    if (!this.sessionId && content.some((block) => block.type === "image")) {
      throw new Error("Cannot hydrate prompt attachments without a Reins session id");
    }
    return this.promptMessage(createReinsInputMessage(content));
  }

  async promptMessage(message: ReinsInputMessage): Promise<void> {
    const submission = Promise.withResolvers<void>();
    this.pendingSubmissions.add(submission);
    let acceptResult;
    try {
      acceptResult = await this.lane.accept({ kind: "prompt", prompt: message }, BACKGROUND_CONTEXT);
    } finally {
      this.pendingSubmissions.delete(submission);
      submission.resolve();
    }
    const accepted = assertOk(acceptResult);
    await this.driveOperationToCompletion(accepted.operationId);
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
    let terminal = false;
    try {
      let result = assertOk(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT));
      while (result.kind === "waiting") {
        result = assertOk(await this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, BACKGROUND_CONTEXT));
      }
      terminal = true;
      if (result.outcome.status !== "completed") {
        throw new Error(result.outcome.error?.message ?? `AgentHarness operation ${result.outcome.status}`);
      }
    } finally {
      this.activeOperations.delete(operationId);
      completion.resolve();
      if (terminal) {
        for (const listener of this.runtimeListeners) listener({ type: "agent_settled" });
      }
    }
  }

  async steer(content: ClientPromptContent): Promise<void> {
    const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
    if (!execution.current || !this.activeOperations.has(execution.current.id)) {
      throw new Error("Cannot steer an idle or passively reopened AgentHarness operation");
    }
    assertOk(await this.lane.steer(createReinsInputMessage(content), undefined, BACKGROUND_CONTEXT));
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingSubmissions.size > 0 || this.activeOperations.size > 0) {
      await Promise.all([
        ...[...this.pendingSubmissions.values()].map((submission) => submission.promise),
        ...[...this.activeOperations.values()].map((completion) => completion.promise),
      ]);
      await this.lane.waitForIdle(BACKGROUND_CONTEXT);
    }
    await this.lane.waitForIdle(BACKGROUND_CONTEXT);
    if (this.pendingSubmissions.size > 0 || this.activeOperations.size > 0) return this.waitForIdle();
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
    this.runtimeListeners.add(listener);
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
      listener({ type: "agent_end", messages: runMessages.get(event.runId) ?? [] });
      runMessages.delete(event.runId);
    }));
    return () => {
      this.runtimeListeners.delete(listener);
      for (const dispose of disposers) dispose();
    };
  }

  async getMessages(): Promise<RuntimeMessage[]> {
    const temporary = this.transcriptWatch ? undefined : await this.lane.watch(BACKGROUND_CONTEXT);
    const transcriptWatch = this.transcriptWatch ?? temporary!;
    try {
      // The retained watch is not treated as a reducer cache; every read resnapshots asynchronously.
      const snapshot = await transcriptWatch.resnapshot(BACKGROUND_CONTEXT);
      return snapshot.transcript.flatMap((entry) => {
        const projected = projectEntry(entry);
        return projected ? [projected] : [];
      });
    } finally {
      temporary?.unsubscribe();
    }
  }

  getSessionMetadata() { return this.metadata; }

  isStreaming(): boolean { return this.pendingSubmissions.size > 0 || this.activeOperations.size > 0; }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await Promise.all([...this.pendingSubmissions].map((submission) => submission.promise));
      try { await this.abort(); }
      finally {
        this.transcriptWatch?.unsubscribe();
        await this.harness.close(BACKGROUND_CONTEXT);
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
}

/**
 * Attach AgentHarness to a fresh canonical Reins session. This constructor is
 * intentionally not registered: legacy sessions require the separately
 * authorized migration before this storage format can be activated.
 */
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
    const restoredModel = await lane.getModel(BACKGROUND_CONTEXT);
    const restoredThinking = await lane.getThinkingLevel(BACKGROUND_CONTEXT);
    if (params.sessionEnvironment && restoredModel) {
      params.sessionEnvironment.provider = restoredModel.provider;
      params.sessionEnvironment.modelId = restoredModel.id;
      params.sessionEnvironment.thinkingLevel = restoredThinking;
    }
    const transcriptWatch = await lane.watch(BACKGROUND_CONTEXT);
    return new AgentHarnessPiRuntime(made.harness, lane, {
      model: restoredModel ? { provider: restoredModel.provider, modelId: restoredModel.id } : null,
      thinkingLevel: restoredThinking,
    }, params.sessionId, made.open.filter((operation) => operation.lane === lane.name), params.options.models, transcriptWatch, params.sessionEnvironment);
  } catch (error) {
    if (harness) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    else await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
    throw error;
  }
}
