/**
 * Runtime-neutral model catalog shapes. The server's catalog is Pi's (`pi/model-catalog.ts`).
 */

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
