import type { ServerState } from "../state.js";
import { createSession as insertSession, updateSessionMeta } from "../session-store.js";
import { getProject } from "../project-store.js";
import { resolveSource } from "../models/sources.js";
import { getTask, touchTask } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { getDb } from "../db.js";
import { parseThinkingLevel, piModelSetting } from "../models/model-settings.js";
import { DEFAULT_SESSION_KIND, sessionKind } from "./session-kinds.js";

export interface SessionCreationOptions {
  taskId?: number;
  parentSessionId?: string;
  title?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  sourceId?: number;
  /** A session the browser never shows: not listed, counted or badged (for Reins features, not scripts). */
  background?: boolean;
  /** How the session runs (`sessions/session-kinds.ts`; for Reins features, not scripts): a registered
   * kind, "agent" by default. */
  kind?: string;
}

/**
 * Creates a session's row, placed on `opts.sourceId`, else on the project's default source
 * (`resolveSource`), and announces it (`session_created`) unless it is a background session. Placement is server policy, not a live
 * connectivity check: a session whose node is not connected is created and its work waits in the outbox
 * until the node connects. The server runs no session: nothing here opens a runtime; the node creates
 * Pi's lane when it first opens the session. Without a model of
 * its own the session gets the `default_model` setting's (throws when that setting is of another runtime).
 * An unknown kind throws.
 */
export function createSession(state: ServerState, projectId: number, opts?: SessionCreationOptions): { id: string } {
  if (!getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
  const kind = opts?.kind ?? DEFAULT_SESSION_KIND;
  sessionKind(kind);

  const source = resolveSource(projectId, opts?.sourceId);
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
      background: opts?.background,
      kind,
    });
    if (opts?.title !== undefined) updateSessionMeta(sessionId, { name: opts.title });
  })();

  // A background session does not move its task up the task list, and is not announced: the browser
  // would list it before learning it is one.
  if (opts?.background) return { id: sessionId };
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
