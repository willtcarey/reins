import type { PromptBlock, RuntimeOperationError } from "@reins/node-protocol";

export type ClientPromptContent = PromptBlock[];
export interface RuntimeRunOutcome {
  runId: string;
  tipId: string | null;
  status: "completed" | "failed" | "aborted";
  error?: RuntimeOperationError;
}
export interface RuntimeLifecycleSink {
  started(runId: string): void;
  settled(runtime: AgentHarnessPiRuntime, outcome: RuntimeRunOutcome): void;
}
export interface RuntimePromptOptions {
  reinsId?: string;
  metadata?: Record<string, unknown>;
}
export interface RuntimePromptSubmission { messageId: string }
/** The model a session selects is not in the node's model registry. */
export class NodeModelNotFoundError extends Error {
  constructor(readonly provider: string, readonly modelId: string) {
    super(`Model not found: ${provider}/${modelId}`);
  }
}
export interface SetRuntimeModelParams { provider: string; modelId: string; thinkingLevel?: string | null }

// Type-only import keeps the lifecycle interface tied to the native node runtime.
import type { AgentHarnessPiRuntime } from "./pi-runtime.js";
