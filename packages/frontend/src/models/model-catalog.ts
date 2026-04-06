export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
}

export interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  keySource: "db" | "env" | "oauth" | null;
  keySources: ("db" | "env" | "oauth")[];
  models: ModelInfo[];
}
