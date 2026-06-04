import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getTask as storeGetTask, type TaskRow } from "../task-store.js";
import type { ServerState } from "../state.js";
import type {
  ClientPromptContent,
  RuntimeContentBlock,
  RuntimeMessage,
} from "../messages-store.js";
import { checkoutBranch } from "../git.js";
import { TaskNotFoundError } from "../models/tasks.js";

export class ModelNotFoundError extends Error {
  readonly provider: string;
  readonly modelId: string;

  constructor(provider: string, modelId: string) {
    super(`Model not found: ${provider}/${modelId}`);
    this.name = "ModelNotFoundError";
    this.provider = provider;
    this.modelId = modelId;
  }
}

export type AvailabilitySourceType = "db" | "env" | "oauth" | "local";

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderInfo {
  provider: string;
  isAvailable: boolean;
  availabilitySource: AvailabilitySourceType | null;
  availabilitySources: AvailabilitySourceType[];
  models: ModelInfo[];
}

export interface RuntimeProviderInfo extends ProviderInfo {
  runtimeType: AgentRuntimeType;
}

type RuntimeBuiltinToolName = "read" | "write" | "edit" | "bash";

export interface RuntimeSessionTools {
  builtins: RuntimeBuiltinToolName[];
  customTools: ToolDefinition[];
}

type RuntimeCompactionEvent =
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean; errorMessage?: string };

/**
 * Streaming delta event for assistant messages. Intentionally loose so both
 * pi (rich AssistantMessageEvent) and Claude SDK (minimal text_delta) can
 * satisfy the type without casting. Consumers only read `type` + `delta`.
 */
type RuntimeAssistantDelta = {
  type: string;
  delta?: string;
  [key: string]: unknown;
};

/**
 * Runtime-agnostic event union emitted by all AgentRuntime implementations.
 * Fully owned by the runtime layer — not derived from any vendor-specific
 * event types — so every runtime can construct events without casting.
 */
export type AgentRuntimeEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: RuntimeMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: RuntimeMessage; toolResults: RuntimeMessage[] }
  | { type: "message_start"; message: RuntimeMessage }
  | { type: "message_update"; message: RuntimeMessage; assistantMessageEvent: RuntimeAssistantDelta }
  | { type: "message_end"; message: RuntimeMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: RuntimeToolResultPayload; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | RuntimeCompactionEvent;

export interface RuntimeToolResultPayload {
  content: RuntimeContentBlock[];
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateAgentRuntimeParams {
  state: ServerState;
  projectId: number;
  projectDir: string;
  sessionId: string;
  task: TaskRow | null;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  sessionTools?: RuntimeSessionTools;
  resume?: boolean;
}

export interface RuntimeAskParams {
  cwd: string;
  prompt: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  systemPrompt?: string;
  timeoutMs?: number;
}

type AgentRuntimeType = string;

export interface SetRuntimeModelParams {
  provider: string;
  modelId: string;
  thinkingLevel?: string | null;
}

export interface AgentRuntime {
  prompt(content: ClientPromptContent): Promise<void>;
  steer(content: ClientPromptContent): Promise<void>;
  abort(): Promise<void>;
  setModel(params: SetRuntimeModelParams): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
  getMessages(): Promise<RuntimeMessage[]>;
  getSessionMetadata?(): {
    model?: { provider: string; modelId: string } | null;
    thinkingLevel?: string | null;
  };
  isStreaming(): boolean;
  close(): Promise<void>;
}

export interface AgentRuntimeAdapter {
  runtimeType: AgentRuntimeType;
  listModels(): Promise<ProviderInfo[]>;
  ask(params: RuntimeAskParams): Promise<string>;
  createRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime>;
}

const runtimeAdapters = new Map<string, AgentRuntimeAdapter>();

export function registerRuntimeAdapter(adapter: AgentRuntimeAdapter): void {
  runtimeAdapters.set(adapter.runtimeType, adapter);
}


export function getRuntimeAdapter(runtimeType: string): AgentRuntimeAdapter {
  const adapter = runtimeAdapters.get(runtimeType);
  if (!adapter) {
    throw new Error(`Runtime adapter '${runtimeType}' is not registered`);
  }
  return adapter;
}

export interface CreateAgentRuntimeInput extends Omit<CreateAgentRuntimeParams, "task"> {
  taskId: number | null;
}

export async function createAgentRuntime(
  runtimeType: string,
  params: CreateAgentRuntimeInput,
): Promise<AgentRuntime> {
  const { taskId, ...rest } = params;

  let task: TaskRow | null = null;
  if (taskId) {
    task = storeGetTask(taskId);
    if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    await checkoutBranch(params.projectDir, task.branch_name);
  }

  const adapter = getRuntimeAdapter(runtimeType);
  return adapter.createRuntime({ ...rest, task });
}

export async function listAllRuntimeProviders(): Promise<RuntimeProviderInfo[]> {
  const result: RuntimeProviderInfo[] = [];

  for (const adapter of runtimeAdapters.values()) {
    const providers = await adapter.listModels();
    for (const provider of providers) {
      result.push({ runtimeType: adapter.runtimeType, ...provider });
    }
  }

  result.sort((a, b) => a.provider.localeCompare(b.provider));

  return result;
}

export function clearRuntimeAdapters(): void {
  runtimeAdapters.clear();
}
