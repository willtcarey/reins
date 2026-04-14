export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
}

export interface ProviderInfo {
  runtimeType: string;
  provider: string;
  isAvailable: boolean;
  availabilitySource: "db" | "env" | "oauth" | "local" | null;
  availabilitySources: ("db" | "env" | "oauth" | "local")[];
  models: ModelInfo[];
}
