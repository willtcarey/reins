import { logger } from "../logger.js";
import { getSession, updateSessionMeta } from "../session-store.js";
import { transcriptResult } from "../models/session-operations.js";
import type { SessionMessages } from "../models/session-messages.js";
import type { Sessions } from "../models/sessions.js";
import type { AgentRuntime, RuntimeLifecycleSink, RuntimeRunOutcome } from "./registry.js";

/** Apply Reins session effects when a runtime reports native operation transitions. */
export class SessionRuntimeLifecycle implements RuntimeLifecycleSink {
  constructor(
    private sessionId: string,
    private sessions: Sessions,
    private messages: SessionMessages,
  ) {}

  started(): void {
    try {
      this.sessions.updateActivityState(this.sessionId, "running");
    } catch (error) {
      logger.error(`Failed to update runtime lifecycle for ${this.sessionId}:`, error);
    }
  }

  settled(runtime: AgentRuntime, outcome: RuntimeRunOutcome): void {
    try {
      this.persistRuntimeMetadata(runtime);
      this.sessions.updateActivityState(this.sessionId, "finished");
      void this.reportSettlement(runtime, outcome)
        .catch((error: unknown) => logger.error(`Failed to report session ${this.sessionId} settlement:`, error));
    } catch (error) {
      logger.error(`Failed to update runtime lifecycle for ${this.sessionId}:`, error);
    }
  }

  private persistRuntimeMetadata(runtime: AgentRuntime): void {
    const metadata = runtime.getSessionMetadata?.();
    if (!metadata?.model?.provider || !metadata.model.modelId) return;
    updateSessionMeta(this.sessionId, {
      modelProvider: metadata.model.provider,
      modelId: metadata.model.modelId,
      thinkingLevel: metadata.thinkingLevel ?? undefined,
    });
  }

  private async reportSettlement(runtime: AgentRuntime, outcome: RuntimeRunOutcome): Promise<void> {
    const child = getSession(this.sessionId);
    const parent = child?.parent_session_id ? getSession(child.parent_session_id) : null;
    if (!child || !parent) return;
    if (child.project_id !== parent.project_id || child.task_id !== parent.task_id) {
      throw new Error("Parent is outside the child's project/task scope");
    }
    const result = transcriptResult(this.sessionId, await runtime.getMessages(), outcome);
    const content = result.status === "completed"
      ? result.result ?? "Session completed."
      : result.error ? `Session ${result.status}: ${result.error}` : `Session ${result.status}.`;
    await this.messages.send(parent.id, content, { sourceSessionId: this.sessionId });
  }
}
