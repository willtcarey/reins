import type { ServerState } from "../state.js";
import { createSession as insertSession, updateSessionMeta } from "../session-store.js";
import { getProject } from "../project-store.js";
import { selectCreationSource } from "./node-source.js";
import { getTask, touchTask } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { getDb } from "../db.js";
import { parseThinkingLevel, piModelSetting } from "../models/model-settings.js";

export interface SessionCreationOptions {
  taskId?: number;
  parentSessionId?: string;
  title?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  sourceId?: number;
}

/**
 * Creates a session's row, placed on `opts.sourceId`, else on the project's default source
 * (`selectCreationSource`), and announces it (`session_created`). The server runs no session: nothing
 * here opens a runtime; the node creates Pi's lane when it first opens the session. Without a model of
 * its own the session gets the `default_model` setting's (throws when that setting is of another runtime).
 */
export function createSession(state: ServerState, projectId: number, opts?: SessionCreationOptions): { id: string } {
  if (!getProject(projectId)) throw new Error(`Project not found: ${projectId}`);

  const source = selectCreationSource(projectId, opts?.sourceId);
  const sessionId = crypto.randomUUID();

  const defaultModel = opts?.model && opts.thinkingLevel ? undefined : piModelSetting("default_model");
  const model = opts?.model ?? (defaultModel && { provider: defaultModel.provider, modelId: defaultModel.modelId });
  const thinkingLevel = opts?.thinkingLevel ? parseThinkingLevel(opts.thinkingLevel) : defaultModel?.thinkingLevel ?? null;

  // Frozen here: the row carries the resolved model/thinking level, from which the node seeds Pi's main
  // lane when it first opens the session's runtime; a later default_model edit does not reach existing
  // sessions. The task is read from its row whenever the node opens the runtime.
  if (opts?.taskId !== undefined && !getTask(opts.taskId)) throw new Error(`Task not found: ${opts.taskId}`);
  getDb().transaction(() => {
    insertSession(sessionId, projectId, {
      modelProvider: model?.provider,
      modelId: model?.modelId,
      thinkingLevel: thinkingLevel ?? "off",
      agentRuntimeType: "pi",
      taskId: opts?.taskId,
      parentSessionId: opts?.parentSessionId,
      sourceId: source.id,
    });
    if (opts?.title !== undefined) updateSessionMeta(sessionId, { name: opts.title });
  })();

  if (opts?.taskId) touchTask(opts.taskId);

  createBroadcast(state.clients)({
    type: "session_created",
    projectId,
    sessionId,
    taskId: opts?.taskId ?? null,
    parentSessionId: opts?.parentSessionId ?? null,
  });

  return { id: sessionId };
}
