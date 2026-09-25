import type { ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { getSession } from "../session-store.js";
import { getSource, internalSource, type Source } from "../node-store.js";
import { ensureSessionOpen, materializeRuntime } from "./session-manager.js";
import type { NodeCommand, NodeResult } from "@reins/node/contract";

/** Session commands resolve the current source before entering host execution. */
export async function executeSessionCommand(
  state: ServerState,
  sessionId: string,
  command: "prompt" | "steer" | "abort" | "resumePending",
  content?: ClientPromptContent,
  clientId?: string,
  sourceSessionId?: string,
): Promise<void> {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id) throw new Error(`Execution source unavailable for session ${sessionId}`);
  const adapter = adapterFor(source);
  return adapter.command(state, sessionId, command, content, clientId, sourceSessionId);
}

export function selectCreationSource(projectId: number, sourceId?: number): Source {
  const source = sourceId === undefined ? internalSource(projectId) : getSource(sourceId);
  if (!source || source.project_id !== projectId) throw new Error(`Execution source unavailable for project ${projectId}`);
  adapterFor(source);
  return source;
}

export function adapterFor(source: Source) {
  if (source.node_id !== "internal") throw new Error(`Execution source unavailable for source ${source.id}`);
  return internalAdapter;
}

const internalAdapter = {
  async open(state: ServerState, command: NodeCommand, _commandId: string): Promise<NodeResult> {
    if (command.op !== "session.open" || command.mode !== "create") throw new Error("Unsupported work command");
    await materializeRuntime(state, command.sessionId);
    return { ok: true, value: { kind: "opened", pendingOperation: false } };
  },
  async command(state: ServerState, sessionId: string, command: "prompt" | "steer" | "abort" | "resumePending", content?: ClientPromptContent, clientId?: string, sourceSessionId?: string): Promise<void> {
  const { runtime } = await ensureSessionOpen(state, sessionId);
  const options = { reinsId: clientId, ...(sourceSessionId ? { metadata: { sourceSessionId } } : {}) };
  switch (command) {
    case "prompt": await runtime.prompt(content!, options); break;
    case "steer": await runtime.steer(content!, options); break;
    case "abort": await runtime.abort(); break;
    case "resumePending":
      if (!runtime.resumePendingOperation) throw new Error("Runtime does not support pending-operation resume");
      await runtime.resumePendingOperation();
  }
  },
};
