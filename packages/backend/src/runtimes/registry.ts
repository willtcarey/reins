/**
 * Model catalogs and utility asks per runtime type. Sessions never run on the server (they run on
 * nodes); the server uses its registered adapters only to list/validate models and for short
 * non-persisted utility prompts (task generation, branch naming).
 */
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

export interface RuntimeAskParams {
  cwd: string;
  prompt: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  systemPrompt?: string;
  timeoutMs?: number;
}

type AgentRuntimeType = string;

export interface AgentRuntimeAdapter {
  runtimeType: AgentRuntimeType;
  listModels(): Promise<ProviderInfo[]>;
  ask(params: RuntimeAskParams): Promise<string>;
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
