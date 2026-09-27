import type { ServerState } from "../state.js";
import { createSession as dbCreateSession, updateSessionMeta } from "../session-store.js";
import { getProject } from "../project-store.js";
import { selectCreationSource } from "./node-source.js";
import { scheduleWork, wakeScheduledCommands } from "../models/node-command-projection.js";
import { getTask, touchTask } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { SessionInstance, type SessionCreationOptions } from "./session-instance.js";
import { getSetting } from "../settings-store.js";
import { parseThinkingLevel } from "../models/model-settings.js";

/** Creates sessions (always for a node: they are queued for provisioning) and scopes session
 * operations to a caller. The server runs no session: nothing here opens a runtime. */
export class SessionManager {
  readonly broadcast: ReturnType<typeof createBroadcast>;

  constructor(readonly state: ServerState) {
    this.broadcast = createBroadcast(state.clients);
  }

  forSession(sessionId: string): SessionInstance {
    return new SessionInstance(this, sessionId);
  }

  create(projectId: number, projectDir: string, options?: SessionCreationOptions): CreatedSession {
    return createManagedSession(this, projectId, projectDir, options);
  }
}

/** The new session and its queued provision command (the session is `provisioning` until it settles). */
export interface CreatedSession { id: string; provisionCommandId: string }

function createManagedSession(
  manager: SessionManager,
  projectId: number,
  projectDir: string,
  opts?: SessionCreationOptions,
): CreatedSession {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const source = selectCreationSource(projectId, opts?.sourceId);
  if (opts?.sourceId === undefined && source.path !== projectDir) throw new Error(`Project source path mismatch: ${projectId}`);
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

  // Frozen here: the provision command (and the row) carry the resolved model/thinking level and a
  // task snapshot; later default_model or task edits do not reach existing sessions.
  const task = opts?.taskId === undefined ? null : getTask(opts.taskId);
  if (opts?.taskId !== undefined && !task) throw new Error(`Task not found: ${opts.taskId}`);
  const configuration = {
    model: selectedCreateModel ? { provider: selectedCreateModel.provider, modelId: selectedCreateModel.modelId } : null,
    thinkingLevel: selectedCreateThinkingLevel ?? null, // the row's "off"
    task: task ? { title: task.title, description: task.description, branchName: task.branch_name } : null,
  };
  const commandId = crypto.randomUUID();
  scheduleWork(commandId, { op: "session.provision", sessionId, sourceId: source.id, configuration }, () => {
    dbCreateSession(sessionId, projectId, {
      modelProvider: selectedCreateModel?.provider,
      modelId: selectedCreateModel?.modelId,
      thinkingLevel: selectedCreateThinkingLevel ?? "off",
      agentRuntimeType: runtimeType,
      taskId: opts?.taskId,
      parentSessionId: opts?.parentSessionId,
      sourceId: source.id,
      placementStatus: "provisioning",
    });
    if (opts?.title !== undefined) updateSessionMeta(sessionId, { name: opts.title });
  });

  // Wake only after committing the row and submission. The response never depends
  // on Pi initialization; a missed wake is recovered by the dispatcher scan.
  queueMicrotask(() => wakeScheduledCommands(manager.state));

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

  return { id: sessionId, provisionCommandId: commandId };
}

/** Create a brand-new session using the process-scoped manager. */
export function createNewSession(
  state: ServerState,
  projectId: number,
  projectDir: string,
  options?: SessionCreationOptions,
): CreatedSession {
  return new SessionManager(state).create(projectId, projectDir, options);
}
