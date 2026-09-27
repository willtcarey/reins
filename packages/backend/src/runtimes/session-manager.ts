import type { ManagedSession, ServerState } from "../state.js";
import {
  createSession as dbCreateSession,
  getSession as dbGetSession,
  updateSessionMeta,
} from "../session-store.js";
import { loadMessages as dbLoadMessages, type ClientPromptContent } from "../messages-store.js";
import { getProject } from "../project-store.js";
import { getSource } from "../node-store.js";
import { selectCreationSource } from "./node-source.js";
import { scheduleWork, getWork, wakeScheduledCommands, type Work } from "../models/node-command-projection.js";
import { getTask, touchTask } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { SessionInstance, type SessionCreationOptions } from "./session-instance.js";
import { createCustomTools } from "../tools/index.js";
import {
  createAgentRuntime,
  ModelNotFoundError,
  type CreateAgentRuntimeParams,
  type RuntimeSessionTools,
} from "./registry.js";
import { getSetting } from "../settings-store.js";
import { parseThinkingLevel } from "../models/model-settings.js";
import { attachRuntimeBroadcastObserver } from "./runtime-broadcast-observer.js";
import { expandLocalPrompt } from "@reins/node/prompt";
import type { AgentRuntime } from "./registry.js";

export class SessionManager {
  readonly sessions: Map<string, ManagedSession>;
  readonly broadcast: ReturnType<typeof createBroadcast>;

  constructor(readonly state: ServerState) {
    this.sessions = state.sessions;
    this.broadcast = createBroadcast(state.clients);
  }

  forSession(sessionId: string): SessionInstance {
    return new SessionInstance(this, sessionId);
  }

  create(projectId: number, projectDir: string, options?: SessionCreationOptions): CreatedSession {
    return createManagedSession(this, projectId, projectDir, options);
  }

  open(sessionId: string): Promise<ManagedSession> {
    return openManagedSession(this, sessionId);
  }
}

function attachPromptExpansion(params: {
  runtime: AgentRuntime;
  cwd: string;
}): void {
  const { runtime, cwd } = params;
  const originalPrompt = runtime.prompt.bind(runtime);
  const originalSteer = runtime.steer.bind(runtime);

  const expand = (content: ClientPromptContent): ClientPromptContent => {
    const { expanded } = expandLocalPrompt(content, cwd);
    return expanded;
  };

  runtime.prompt = (content, options) => originalPrompt(expand(content), options);
  runtime.steer = (content, options) => originalSteer(expand(content), options);
}

function resolveSessionTools(params: {
  manager: SessionManager;
  projectId: number;
  sessionId: string;
  taskId: number | null;
  instance: SessionInstance;
}): RuntimeSessionTools {
  const { manager, projectId, sessionId, taskId, instance } = params;
  const harnessTools = createCustomTools({
    projectId,
    sessionId,
    taskId,
    broadcast: manager.broadcast,
    sessions: manager.sessions,
    instance,
  });

  return {
    builtins: ["read", "write", "edit", "bash"],
    harnessTools,
  };
}


async function createManagedSessionRuntime(params: {
  manager: SessionManager;
  runtimeType: string;
  projectId: number;
  projectDir: string;
  sessionId: string;
  taskId: number | null;
  model?: CreateAgentRuntimeParams["model"];
  thinkingLevel?: CreateAgentRuntimeParams["thinkingLevel"];
  resume?: boolean;
}): Promise<ManagedSession> {
  const {
    manager,
    runtimeType,
    projectId,
    projectDir,
    sessionId,
    taskId,
    model,
    thinkingLevel,
    resume,
  } = params;
  const { state } = manager;

  const instance = manager.forSession(sessionId);
  const sessionTools = resolveSessionTools({
    manager,
    projectId,
    sessionId,
    taskId,
    instance,
  });
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>>;

  try {
    runtime = await createAgentRuntime(runtimeType, {
      state,
      projectId,
      projectDir,
      sessionId,
      taskId,
      model,
      thinkingLevel,
      sessionTools,
      lifecycle: instance,
      resume,
    });
  } catch (err) {
    if (err instanceof ModelNotFoundError) {
      const configuredDefaultModel = getSetting("default_model");
      const selectedIsConfiguredDefault = configuredDefaultModel
        && configuredDefaultModel.runtimeType === runtimeType
        && configuredDefaultModel.provider === err.provider
        && configuredDefaultModel.modelId === err.modelId;

      if (selectedIsConfiguredDefault) {
        throw new Error(
          `Configured default_model is invalid: ${err.provider}/${err.modelId}. Update it in Settings.`,
          { cause: err },
        );
      }

      throw new Error(`Selected session model is invalid: ${err.provider}/${err.modelId}`, { cause: err });
    }

    throw err;
  }

  attachPromptExpansion({ runtime, cwd: projectDir });

  const detachRuntimeBroadcastObserver = attachRuntimeBroadcastObserver({
    sessionId,
    projectId,
    runtime,
    clients: state.clients,
  });
  let observerDetached = false;
  const detachRuntimeObserver = () => {
    if (observerDetached) return;
    observerDetached = true;
    detachRuntimeBroadcastObserver();
  };

  const originalClose = runtime.close.bind(runtime);
  runtime.close = async () => {
    try {
      await originalClose();
    } finally {
      detachRuntimeObserver();
    }
  };

  const managed: ManagedSession = {
    id: sessionId,
    runtime,
    lastActivity: Date.now(),
  };

  state.sessions.set(sessionId, managed);

  return managed;
}

/**
 * Create a brand-new session with runtime-agnostic persistence orchestration.
 */
export interface CreatedSession { id: string; scheduling: Work }

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
      storageOwner: opts?.storageOwner ?? (source.node_id === "internal" ? "internal-node" : "server"),
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

  return { id: sessionId, scheduling: { ...getWork(commandId)! } };
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

async function openManagedSession(
  manager: SessionManager,
  sessionId: string,
): Promise<ManagedSession> {
  const { state } = manager;
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  const openings = state.sessionOpenings ??= new Map();
  const opening = openings.get(sessionId);
  if (opening) return opening;
  const pending = reopenSession(manager, sessionId);
  openings.set(sessionId, pending);
  try {
    return await pending;
  } finally {
    openings.delete(sessionId);
  }
}

/** Ensure a legacy server-owned session is open using the process-scoped manager. Node-owned sessions
 * are never opened by the server: the node opens them on command, and this rejects them. */
export async function ensureSessionOpen(state: ServerState, sessionId: string): Promise<ManagedSession> {
  return new SessionManager(state).open(sessionId);
}

async function reopenSession(manager: SessionManager, sessionId: string): Promise<ManagedSession> {
  const row = dbGetSession(sessionId);
  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (row.storage_owner === "internal-node") throw new Error("Node-owned sessions open on the node");

  const project = getProject(row.project_id);
  if (!project) {
    throw new Error(`Project not found: ${row.project_id}`);
  }

  const source = getSource(row.source_id);
  if (!source || source.project_id !== row.project_id) {
    throw new Error(`Execution source unavailable for session ${sessionId}`);
  }

  if (source.node_id !== "internal") throw new Error(`Execution source unavailable for source ${source.id}`);
  const defaultModel = getSetting("default_model");
  const selectedResumeModel = (row.model_provider && row.model_id)
    ? {
      provider: row.model_provider,
      modelId: row.model_id,
    }
    : (defaultModel && defaultModel.runtimeType === row.agent_runtime_type
      ? {
        provider: defaultModel.provider,
        modelId: defaultModel.modelId,
      }
      : null);

  const selectedResumeThinkingLevel = row.thinking_level === "off"
    ? null
    : (row.thinking_level
      ? parseThinkingLevel(row.thinking_level)
      : (defaultModel && defaultModel.runtimeType === row.agent_runtime_type
        ? defaultModel.thinkingLevel
        : null));
  const hasPersistedMessages = dbLoadMessages(sessionId).length > 0;

  return createManagedSessionRuntime({
    manager,
    runtimeType: row.agent_runtime_type,
    projectId: row.project_id,
    projectDir: source.path,
    sessionId,
    taskId: row.task_id,
    model: selectedResumeModel,
    thinkingLevel: selectedResumeThinkingLevel,
    resume: hasPersistedMessages,
  });
}
