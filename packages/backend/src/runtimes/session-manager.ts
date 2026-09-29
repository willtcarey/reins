import type { ServerState } from "../state.js";
import { createSession as dbCreateSession, updateSessionMeta } from "../session-store.js";
import { getProject } from "../project-store.js";
import { selectCreationSource } from "./node-source.js";
import { getTask, touchTask } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { SessionInstance, type SessionCreationOptions } from "./session-instance.js";
import { getSetting } from "../settings-store.js";
import { getDb } from "../db.js";
import { parseThinkingLevel } from "../models/model-settings.js";

/** Creates sessions (each on a node: its source's) and scopes session operations to a caller. The server
 * runs no session: nothing here opens a runtime. */
export class SessionManager {
  readonly broadcast: ReturnType<typeof createBroadcast>;

  constructor(readonly state: ServerState) {
    this.broadcast = createBroadcast(state.clients);
  }

  forSession(sessionId: string): SessionInstance {
    return new SessionInstance(this, sessionId);
  }

  create(projectId: number, options?: SessionCreationOptions): CreatedSession {
    return createManagedSession(this, projectId, options);
  }
}

/** The new session. */
export interface CreatedSession { id: string }

/** Placed on `opts.sourceId`, else on the project's default source (`selectCreationSource`). */
function createManagedSession(
  manager: SessionManager,
  projectId: number,
  opts?: SessionCreationOptions,
): CreatedSession {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const source = selectCreationSource(projectId, opts?.sourceId);
  const sessionId = crypto.randomUUID();

  const defaultModel = getSetting("default_model");
  if (!opts?.model && defaultModel && defaultModel.runtimeType !== "pi") {
    throw new Error(
      `Configured default_model uses unavailable runtime '${defaultModel.runtimeType}'. Update it in Settings.`,
    );
  }
  const selectedCreateModel = opts?.model
    ?? (defaultModel && {
      provider: defaultModel.provider,
      modelId: defaultModel.modelId,
    });
  const runtimeType = "pi";
  const selectedCreateThinkingLevel = opts?.thinkingLevel
    ? parseThinkingLevel(opts.thinkingLevel)
    : defaultModel?.thinkingLevel ?? null;

  // Frozen here: the row carries the resolved model/thinking level, from which the node seeds Pi's main
  // lane when it first opens the session's runtime; a later default_model edit does not reach existing
  // sessions. The task is read from its row whenever the node opens the runtime.
  if (opts?.taskId !== undefined && !getTask(opts.taskId)) throw new Error(`Task not found: ${opts.taskId}`);
  getDb().transaction(() => {
    dbCreateSession(sessionId, projectId, {
      modelProvider: selectedCreateModel?.provider,
      modelId: selectedCreateModel?.modelId,
      thinkingLevel: selectedCreateThinkingLevel ?? "off",
      agentRuntimeType: runtimeType,
      taskId: opts?.taskId,
      parentSessionId: opts?.parentSessionId,
      sourceId: source.id,
      placementStatus: "provisioned",
    });
    if (opts?.title !== undefined) updateSessionMeta(sessionId, { name: opts.title });
  })();

  if (opts?.taskId) {
    touchTask(opts.taskId);
  }

  manager.broadcast({
    type: "session_created",
    projectId,
    sessionId,
    taskId: opts?.taskId ?? null,
    parentSessionId: opts?.parentSessionId ?? null,
  });

  return { id: sessionId };
}

/** Create a brand-new session using the process-scoped manager. */
export function createNewSession(
  state: ServerState,
  projectId: number,
  options?: SessionCreationOptions,
): CreatedSession {
  return new SessionManager(state).create(projectId, options);
}
