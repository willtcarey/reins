import { persistMessages, updateSessionMeta } from "../session-store.js";
import { getPiSession, isPiRuntime } from "./pi/runtime.js";
import { filterErrorMessages } from "./pi/session.js";
import type { AgentRuntime, AgentRuntimeEvent } from "./registry.js";

function shouldPersistForRuntimeEvent(event: AgentRuntimeEvent): boolean {
  if (!event || typeof event !== "object") return false;

  if (event.type === "turn_end" || event.type === "agent_end") {
    return true;
  }

  if (event.type === "compaction_end" && !event.aborted) {
    return true;
  }

  return false;
}

function normalizeRuntimeMessagesForPersistence(runtime: AgentRuntime, messages: unknown[]): unknown[] {
  if (isPiRuntime(runtime)) {
    return filterErrorMessages(messages);
  }
  return messages;
}

function deriveRuntimeSessionMetadata(runtime: AgentRuntime): {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
} | null {
  const metadata = runtime.getSessionMetadata?.();
  if (metadata?.model?.provider && metadata.model.modelId) {
    return {
      modelProvider: metadata.model.provider,
      modelId: metadata.model.modelId,
      thinkingLevel: metadata.thinkingLevel ?? undefined,
    };
  }

  if (isPiRuntime(runtime)) {
    const session = getPiSession(runtime);
    const model = session.model;
    if (model) {
      return {
        modelProvider: model.provider,
        modelId: model.id,
        thinkingLevel: session.thinkingLevel ?? undefined,
      };
    }
  }

  return null;
}

async function persistRuntimeStateFromRuntime(params: {
  sessionId: string;
  runtime: AgentRuntime;
  event: AgentRuntimeEvent;
}): Promise<void> {
  const { sessionId, runtime, event } = params;

  if (!shouldPersistForRuntimeEvent(event)) return;

  const messages = await runtime.getMessages();
  const normalized = normalizeRuntimeMessagesForPersistence(runtime, messages);
  persistMessages(sessionId, normalized);

  if (event.type !== "agent_end") return;

  const metadata = deriveRuntimeSessionMetadata(runtime);
  if (!metadata?.modelProvider || !metadata.modelId) return;

  updateSessionMeta(sessionId, {
    modelProvider: metadata.modelProvider,
    modelId: metadata.modelId,
    thinkingLevel: metadata.thinkingLevel,
  });
}

export function attachRuntimePersistenceObserver(params: {
  sessionId: string;
  runtime: AgentRuntime;
}): () => void {
  const { sessionId, runtime } = params;

  return runtime.subscribe((event) => {
    void persistRuntimeStateFromRuntime({ sessionId, runtime, event }).catch((err) => {
      console.error(`  Failed to persist runtime state for ${sessionId}:`, err);
    });
  });
}
