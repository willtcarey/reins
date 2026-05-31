import {
  query,
  type Query,
  type SDKUserMessage,
  type HookInput,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  SetRuntimeModelParams,
} from "../registry.js";
import type { RuntimePromptContent } from "../../content-blocks.js";
import { ClaudeStreamProcessor } from "./stream-processor.js";
import { createClaudeCustomToolsServer } from "./tools.js";
import { createSessionStore } from "./session-store.js";
import { loadMessagesForLLM } from "../../messages-store.js";
import { resolveClaudeBinary } from "./resolve-binary.js";

const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Bash"] as const;

type PromptDeferred = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export function isThinkingDisabled(level: string | null | undefined): boolean {
  return !level || level === "off";
}

export function mapThinkingEffort(level: string | null | undefined): "low" | "medium" | "high" | "xhigh" | "max" {
  if (level === "minimal") return "low";
  if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max") return level;
  return "high";
}

type SDKUserContentBlocks = Exclude<SDKUserMessage["message"]["content"], string>;

type SDKImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function toSDKImageMediaType(mimeType: string): SDKImageMediaType | null {
  if (mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp") {
    return mimeType;
  }
  return null;
}

function buildUserMessage(content: RuntimePromptContent): SDKUserMessage {
  const blocks: SDKUserContentBlocks = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      const mediaType = toSDKImageMediaType(block.mimeType);
      if (!mediaType) return { type: "text", text: `[Unsupported image type: ${block.mimeType}]` };
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: block.data,
        },
      };
    });

  return {
    type: "user",
    message: {
      role: "user",
      content: blocks,
    },
    parent_tool_use_id: null,
  };
}

class SdkInputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  enqueue(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Claude input stream is closed");
    }

    const next = this.waiters.shift();
    if (next) {
      next({ value: message, done: false });
      return;
    }

    this.queued.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next) continue;
      next({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const queued = this.queued.shift();
        if (queued) {
          return { value: queued, done: false };
        }

        if (this.closed) {
          return { value: undefined, done: true };
        }

        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function toError(error: unknown, fallback = "Claude query failed"): Error {
  return error instanceof Error ? error : new Error(String(error ?? fallback));
}

export class ClaudeSdkAgentRuntime implements AgentRuntime {
  readonly runtimeType = "claude_agent_sdk" as const;

  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>();
  private readonly abortController = new AbortController();
  private currentToolAbortController = new AbortController();
  private readonly processor = new ClaudeStreamProcessor();

  private queryHandle: Query | null = null;
  private inputStream: SdkInputStream | null = null;
  private consumePromise: Promise<void> | null = null;
  private closed = false;
  private streaming = false;
  private hasStartedQuery = false;

  // Prompt completion tracking — each prompt() gets an ID and a deferred promise
  // that resolves when the SDK emits agent_end for that prompt.
  private nextPromptId = 1;
  private activePromptId: number | null = null;
  private promptDeferreds = new Map<number, PromptDeferred>();

  private modelProvider: string | null;
  private modelId: string | null;
  private thinkingLevel: string | null;

  constructor(private readonly params: {
    sessionId: string;
    projectDir: string;
    systemPrompt: string;
    resumeOnFirstPrompt: boolean;
    model?: { provider: string; modelId: string } | null;
    thinkingLevel?: string | null;
    customTools: import("@mariozechner/pi-coding-agent").ToolDefinition[];
  }) {
    this.modelProvider = params.model?.provider ?? null;
    this.modelId = params.model?.modelId ?? null;
    this.thinkingLevel = params.thinkingLevel ?? null;
  }

  private emit(event: AgentRuntimeEvent): void {
    if (event.type === "turn_start") this.streaming = true;
    if (event.type === "agent_end") this.streaming = false;
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Immediately signal that streaming has begun so the frontend reflects
   * the active state without waiting for the SDK subprocess to produce its
   * first content event.  Also marks `emittedTurnStart` on the mapper state
   * so the event mapper doesn't emit a duplicate `agent_start` later.
   */
  private signalStreamingStart(): void {
    this.streaming = true;
    this.processor.markStreamingStarted();
    this.emit({ type: "agent_start" });
  }

  private createPromptCompletion(promptId: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.promptDeferreds.set(promptId, { resolve, reject });
    });
  }

  private resolvePrompt(promptId: number): void {
    const deferred = this.promptDeferreds.get(promptId);
    if (!deferred) return;
    this.promptDeferreds.delete(promptId);
    deferred.resolve();
  }

  private rejectPrompt(promptId: number, error: unknown): void {
    const deferred = this.promptDeferreds.get(promptId);
    if (!deferred) return;
    this.promptDeferreds.delete(promptId);
    deferred.reject(toError(error));
  }

  private failOutstandingPrompts(error: unknown): void {
    const resolvedError = toError(error, "Claude query ended unexpectedly");
    const wasStreaming = this.streaming;
    this.streaming = false;

    // If we signalled streaming start, emit agent_end with a structured
    // assistant error message so the frontend can surface the failure in
    // chat state, not just through the initiating client's WS error banner.
    if (wasStreaming) {
      this.emit({
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: resolvedError.message,
          timestamp: Date.now(),
        }],
      });
    }

    if (this.activePromptId !== null) {
      this.rejectPrompt(this.activePromptId, resolvedError);
      this.activePromptId = null;
    }

    for (const [promptId, deferred] of this.promptDeferreds.entries()) {
      this.promptDeferreds.delete(promptId);
      deferred.reject(resolvedError);
    }
  }

  private resolveSessionOption(): { resume: string } | { sessionId: string } {
    if (this.hasStartedQuery) {
      return { resume: this.params.sessionId };
    }

    return this.params.resumeOnFirstPrompt
      ? { resume: this.params.sessionId }
      : { sessionId: this.params.sessionId };
  }

  private resetQueryHandle(): void {
    this.queryHandle = null;
    this.inputStream?.close();
    this.inputStream = null;
  }

  private startToolAbortScope(): void {
    this.currentToolAbortController = new AbortController();
  }

  private abortActiveTools(): void {
    this.currentToolAbortController.abort();
  }

  private enqueuePrompt(content: RuntimePromptContent): void {
    if (!this.inputStream) {
      throw new Error("Claude input stream is unavailable");
    }

    this.inputStream.enqueue(buildUserMessage(content));
  }

  private buildQueryOptions(
    mcpServer: ReturnType<typeof createClaudeCustomToolsServer>,
  ): NonNullable<Parameters<typeof query>[0]["options"]> {
    return {
      pathToClaudeCodeExecutable: resolveClaudeBinary(),
      cwd: this.params.projectDir,
      includePartialMessages: true,
      tools: [...BUILTIN_TOOLS],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      settings: { includeCoAuthoredBy: false },
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: this.params.systemPrompt,
      sessionStore: createSessionStore(this.params.sessionId, this.params.projectDir),
      thinking: isThinkingDisabled(this.thinkingLevel) ? { type: "disabled" } : { type: "enabled" },
      ...(isThinkingDisabled(this.thinkingLevel) ? {} : { effort: mapThinkingEffort(this.thinkingLevel) }),
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      },
      hooks: {
        PostCompact: [{
          hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
            if (input.hook_event_name === "PostCompact") {
              this.processor.setCompactSummary(input.compact_summary);
            }
            return { continue: true };
          }],
        }],
      },
      ...(this.modelId ? { model: this.modelId } : {}),
      ...(mcpServer ? { mcpServers: { "custom-tools": mcpServer } } : {}),
      ...this.resolveSessionOption(),
    };
  }

  private async ensureQueryStarted(): Promise<void> {
    if (this.queryHandle) return;
    if (this.closed) throw new Error("Runtime closed");

    const mcpServer = createClaudeCustomToolsServer({
      customTools: this.params.customTools,
      getSignal: () => this.currentToolAbortController.signal,
    });

    const options = this.buildQueryOptions(mcpServer);
    const inputStream = new SdkInputStream();

    try {
      this.inputStream = inputStream;
      this.queryHandle = query({ prompt: inputStream, options });
      this.hasStartedQuery = true;
      this.consumePromise = this.consumeSdkMessages();
    } catch (error) {
      inputStream.close();
      this.inputStream = null;
      throw error;
    }
  }

  private async consumeSdkMessages(): Promise<void> {
    const current = this.queryHandle;
    if (!current) return;

    try {
      for await (const sdkMessage of current) {
        const mappedEvents = this.processor.process(sdkMessage);

        for (const event of mappedEvents) {
          this.emit(event);
          if (event.type === "agent_end" && this.activePromptId !== null) {
            const finishedPromptId = this.activePromptId;
            this.activePromptId = null;
            this.resolvePrompt(finishedPromptId);
          }
        }
      }

      this.resetQueryHandle();
      this.failOutstandingPrompts(new Error("Claude query stream closed"));
    } catch (error) {
      this.resetQueryHandle();
      this.failOutstandingPrompts(error);
    }
  }

  async prompt(content: RuntimePromptContent): Promise<void> {
    if (this.closed) throw new Error("Runtime closed");

    const promptId = this.nextPromptId++;
    const completion = this.createPromptCompletion(promptId);

    if (!this.queryHandle) {
      this.activePromptId = promptId;
      this.startToolAbortScope();
      try {
        await this.ensureQueryStarted();
        this.enqueuePrompt(content);
        this.signalStreamingStart();
      } catch (error) {
        this.activePromptId = null;
        this.rejectPrompt(promptId, error);
        return completion;
      }
      return completion;
    }

    if (this.activePromptId !== null) {
      this.rejectPrompt(promptId, new Error("Prompt already running. Wait for completion or abort and send a new prompt."));
      return completion;
    }

    this.activePromptId = promptId;
    this.startToolAbortScope();
    try {
      this.enqueuePrompt(content);
      this.signalStreamingStart();
    } catch (error) {
      this.activePromptId = null;
      this.rejectPrompt(promptId, error);
      return completion;
    }

    return completion;
  }

  async steer(_content: RuntimePromptContent): Promise<void> {
    if (this.closed) throw new Error("Runtime closed");
    throw new Error("Steering is not supported on Claude runtime yet. Wait for completion or abort and send a new prompt.");
  }

  async abort(): Promise<void> {
    this.abortActiveTools();
    await this.queryHandle?.interrupt().catch(() => undefined);
  }

  async setModel(params: SetRuntimeModelParams): Promise<void> {
    this.modelProvider = params.provider;
    this.modelId = params.modelId;
    this.thinkingLevel = params.thinkingLevel ?? this.thinkingLevel;

    if (this.queryHandle) {
      await this.queryHandle.setModel(params.modelId);
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getMessages(): Promise<AgentRuntimeMessage[]> {
    return loadMessagesForLLM(this.params.sessionId);
  }

  getSessionMetadata(): { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null } {
    return {
      model: this.modelProvider && this.modelId
        ? { provider: this.modelProvider, modelId: this.modelId }
        : null,
      thinkingLevel: this.thinkingLevel,
    };
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortActiveTools();
    this.abortController.abort();

    const current = this.queryHandle;
    this.resetQueryHandle();
    current?.close?.();

    this.failOutstandingPrompts(new Error("Runtime closed"));
    if (this.consumePromise) {
      await this.consumePromise.catch(() => undefined);
    }
  }
}
