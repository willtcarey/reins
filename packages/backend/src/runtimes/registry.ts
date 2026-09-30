/**
 * Runtime-neutral model catalog and utility-ask shapes. The server's catalog and asks are Pi's
 * (`pi/model-catalog.ts`, `pi/utility.ts`).
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

/** A one-shot utility prompt (task generation). Without `model`, the configured utility model, else
 * the default model. */
export interface RuntimeAskParams {
  cwd: string;
  prompt: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  systemPrompt?: string;
  timeoutMs?: number;
}
