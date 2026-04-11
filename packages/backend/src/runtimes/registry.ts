import type { ServerState } from "../state.js";

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

export type KeySourceType = "db" | "env" | "oauth" | "local";

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  keySource: KeySourceType | null;
  keySources: KeySourceType[];
  models: ModelInfo[];
}

export interface RuntimeProviderInfo extends ProviderInfo {
  runtimeType: AgentRuntimeType;
}

export type RuntimeBuiltinToolName = "read" | "write" | "edit" | "bash";

export type RuntimeCustomToolName = "create_task" | "delegate" | "search" | "execute";

export interface RuntimeSessionTools {
  builtins: RuntimeBuiltinToolName[];
  customTools: any[];
}

export interface CreateAgentRuntimeParams {
  state: ServerState;
  projectId: number;
  projectDir: string;
  sessionId: string;
  taskId: number | null;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  sessionTools?: RuntimeSessionTools;
}

export type AgentRuntimeType = string;

export interface AgentRuntime {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
  getMessages(): Promise<any[]>;
  isStreaming(): boolean;
  close(): Promise<void>;
}

export interface AgentRuntimeAdapter {
  runtimeType: AgentRuntimeType;
  listModels(): Promise<ProviderInfo[]>;
  createRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime>;
}

const runtimeAdapters = new Map<string, AgentRuntimeAdapter>();

export function registerRuntimeAdapter(adapter: AgentRuntimeAdapter): void {
  runtimeAdapters.set(adapter.runtimeType, adapter);
}

export function isRuntimeAdapterRegistered(runtimeType: string): boolean {
  return runtimeAdapters.has(runtimeType);
}

export function getRuntimeAdapter(runtimeType: string): AgentRuntimeAdapter {
  const adapter = runtimeAdapters.get(runtimeType);
  if (!adapter) {
    throw new Error(`Runtime adapter '${runtimeType}' is not registered`);
  }
  return adapter;
}

export async function createAgentRuntime(
  runtimeType: string,
  params: CreateAgentRuntimeParams,
): Promise<AgentRuntime> {
  const adapter = getRuntimeAdapter(runtimeType);
  return adapter.createRuntime(params);
}

export async function listAllRuntimeProviders(): Promise<RuntimeProviderInfo[]> {
  const result: RuntimeProviderInfo[] = [];

  for (const adapter of runtimeAdapters.values()) {
    const providers = await adapter.listModels();
    for (const provider of providers) {
      result.push({ runtimeType: adapter.runtimeType, ...provider });
    }
  }

  return result;
}

export function clearRuntimeAdapters(): void {
  runtimeAdapters.clear();
}
