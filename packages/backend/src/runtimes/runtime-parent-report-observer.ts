import { getSession } from "../session-store.js";
import { transcriptResult } from "../models/session-orchestration.js";
import type { SessionMessages } from "../models/session-messages.js";
import { logger } from "../logger.js";
import type { AgentRuntime } from "./registry.js";

/** Subscribe after persistence so flush includes the settlement checkpoint. */
export function attachRuntimeParentReportObserver(params: {
  sessionId: string;
  runtime: AgentRuntime;
  flushPersistence: () => Promise<void>;
  messages: SessionMessages;
}): () => void {
  const { sessionId, runtime, flushPersistence, messages } = params;
  return runtime.subscribe((event) => {
    if (event.type !== (runtime.activityCompletionBoundary ?? "agent_end")) return;
    const report = async () => {
      await flushPersistence();
      const child = getSession(sessionId);
      const parent = child?.parent_session_id ? getSession(child.parent_session_id) : null;
      if (!child || !parent) return;
      if (child.project_id !== parent.project_id || child.task_id !== parent.task_id) {
        throw new Error("Parent is outside the child's project/task scope");
      }
      const outcome = transcriptResult(sessionId, await runtime.getMessages());
      await messages.send(parent.id,
        `REINS session notification (not a user request)\n${JSON.stringify({ type: "session.settled", ...outcome })}`);
    };
    void report().catch((error: unknown) => logger.error(`Failed to report session ${sessionId} settlement:`, error));
  });
}
