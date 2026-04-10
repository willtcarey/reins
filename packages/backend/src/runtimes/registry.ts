export type AgentRuntimeType = "pi";

export interface AgentRuntime {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
  getMessages(): Promise<any[]>;
  close(): Promise<void>;
}

export interface AgentRuntimeCreateParams {
  pi: {
    session: any;
  };
}

export interface AgentRuntimeAdapter {
  runtimeType: AgentRuntimeType;
  createRuntime(params: AgentRuntimeCreateParams[AgentRuntimeType]): Promise<AgentRuntime>;
}

const runtimeAdapters = new Map<AgentRuntimeType, AgentRuntimeAdapter>();

export function registerRuntimeAdapter(adapter: AgentRuntimeAdapter): void {
  runtimeAdapters.set(adapter.runtimeType, adapter);
}

export function getRuntimeAdapter(runtimeType: AgentRuntimeType): AgentRuntimeAdapter {
  const adapter = runtimeAdapters.get(runtimeType);
  if (!adapter) {
    throw new Error(`Runtime adapter '${runtimeType}' is not registered`);
  }
  return adapter;
}

export async function createAgentRuntime(
  runtimeType: AgentRuntimeType,
  params: AgentRuntimeCreateParams[AgentRuntimeType],
): Promise<AgentRuntime> {
  const adapter = getRuntimeAdapter(runtimeType);
  return adapter.createRuntime(params);
}

export function clearRuntimeAdapters(): void {
  runtimeAdapters.clear();
}
