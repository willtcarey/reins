import { logger } from "../logger.js";
import { updateSessionMeta } from "../session-store.js";
import type { Sessions } from "../models/sessions.js";
import type { AgentRuntime } from "./registry.js";

function persistRuntimeMetadata(sessionId: string, runtime: AgentRuntime): void {
  const metadata = runtime.getSessionMetadata?.();
  if (!metadata?.model?.provider || !metadata.model.modelId) return;
  updateSessionMeta(sessionId, {
    modelProvider: metadata.model.provider,
    modelId: metadata.model.modelId,
    thinkingLevel: metadata.thinkingLevel ?? undefined,
  });
}

/** Observe activity and final runtime metadata. AgentHarness stores transcript entries directly. */
export function attachRuntimeLifecycleObserver(params: {
  sessionId: string;
  runtime: AgentRuntime;
  sessions: Sessions;
}): () => void {
  const { sessionId, runtime, sessions } = params;
  return runtime.subscribe((event) => {
    try {
      if (event.type === "agent_start" || event.type === "compaction_start") {
        sessions.updateActivityState(sessionId, "running");
        return;
      }
      if (event.type !== "agent_end") return;
      persistRuntimeMetadata(sessionId, runtime);
      sessions.updateActivityState(sessionId, "finished");
    } catch (error) {
      logger.error(`Failed to update runtime lifecycle for ${sessionId}:`, error);
    }
  });
}
