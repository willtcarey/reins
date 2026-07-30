import { logger } from "../logger.js";
import { persistMessages, type RuntimeMessage } from "../messages-store.js";
import { updateSessionMeta } from "../session-store.js";
import type { Sessions } from "../models/sessions.js";
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

function getActivityStateForEvent(event: AgentRuntimeEvent): "running" | "finished" | null {
  if (event.type === "agent_start" || event.type === "compaction_start") return "running";
  if (event.type === "agent_end") return "finished";

  // A non-retrying compaction may be terminal after a prior agent_end, so do
  // not wait for another agent_end to clear the running state from compaction_start.
  if (event.type === "compaction_end" && event.willRetry === false) return "finished";

  return null;
}

function normalizeRuntimeMessagesForPersistence(messages: RuntimeMessage[]): RuntimeMessage[] {
  return messages.filter((message) => {
    if (
      message.role === "assistant"
      && message.stopReason === "error"
      && Array.isArray(message.content)
      && message.content.length === 0
    ) {
      return false;
    }
    return true;
  });
}

function deriveRuntimeSessionMetadata(runtime: AgentRuntime): {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
} | null {
  const metadata = runtime.getSessionMetadata?.();
  if (!metadata?.model?.provider || !metadata.model.modelId) {
    return null;
  }

  return {
    modelProvider: metadata.model.provider,
    modelId: metadata.model.modelId,
    thinkingLevel: metadata.thinkingLevel ?? undefined,
  };
}

async function persistRuntimeSnapshot(params: {
  sessionId: string;
  runtime: AgentRuntime;
  event: AgentRuntimeEvent;
  updateMetadata: boolean;
}): Promise<void> {
  const { sessionId, runtime, event, updateMetadata } = params;

  const messages = await runtime.getMessages();
  const normalized = normalizeRuntimeMessagesForPersistence(messages);
  persistMessages(sessionId, normalized);

  if (!updateMetadata || event.type !== "agent_end") return;

  const metadata = deriveRuntimeSessionMetadata(runtime);
  if (!metadata?.modelProvider || !metadata.modelId) return;

  updateSessionMeta(sessionId, {
    modelProvider: metadata.modelProvider,
    modelId: metadata.modelId,
    thinkingLevel: metadata.thinkingLevel,
  });
}

async function persistRuntimeStateFromRuntime(params: {
  sessionId: string;
  runtime: AgentRuntime;
  event: AgentRuntimeEvent;
  sessions: Sessions;
}): Promise<void> {
  const { sessionId, runtime, event, sessions } = params;

  const nextActivityState = getActivityStateForEvent(event);

  // Running state should remain immediate. Terminal state must wait until the
  // checkpoint is durable so its session_updated broadcast cannot trigger a
  // refresh that races ahead of final message persistence.
  if (nextActivityState === "running") {
    sessions.updateActivityState(sessionId, nextActivityState);
  }

  if (shouldPersistForRuntimeEvent(event)) {
    await persistRuntimeSnapshot({
      sessionId,
      runtime,
      event,
      updateMetadata: true,
    });
  }

  if (nextActivityState === "finished") {
    sessions.updateActivityState(sessionId, nextActivityState);
  }
}

export function attachRuntimePersistenceObserver(params: {
  sessionId: string;
  runtime: AgentRuntime;
  sessions: Sessions;
}): () => void {
  const { sessionId, runtime, sessions } = params;
  let checkpointQueue = Promise.resolve();

  return runtime.subscribe((event) => {
    const persist = () => persistRuntimeStateFromRuntime({ sessionId, runtime, event, sessions });
    const operation = shouldPersistForRuntimeEvent(event)
      ? (checkpointQueue = checkpointQueue.then(persist, persist))
      : persist();

    void operation.catch((err) => {
      logger.error(`  Failed to persist runtime state for ${sessionId}:`, err);
    });
  });
}
