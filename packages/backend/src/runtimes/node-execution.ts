import type { ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import { ensureSessionOpen } from "./session-manager.js";

/** Session commands resolve the immutable source binding before entering host execution. */
export async function executeSessionCommand(
  state: ServerState,
  sessionId: string,
  command: "prompt" | "steer" | "abort" | "resumePending",
  content?: ClientPromptContent,
  clientId?: string,
): Promise<void> {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id || source.node_id !== "internal") {
    throw new Error(`Execution source unavailable for session ${sessionId}`);
  }
  const { runtime } = await ensureSessionOpen(state, sessionId);
  switch (command) {
    case "prompt": await runtime.prompt(content!, { reinsId: clientId }); break;
    case "steer": await runtime.steer(content!, { reinsId: clientId }); break;
    case "abort": await runtime.abort(); break;
    case "resumePending":
      if (!runtime.resumePendingOperation) throw new Error("Runtime does not support pending-operation resume");
      await runtime.resumePendingOperation();
  }
}
