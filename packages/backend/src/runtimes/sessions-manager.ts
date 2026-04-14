import type { ManagedSession, ServerState } from "../state.js";
import {
  createSession as dbCreateSession,
  deleteSession as dbDeleteSession,
  getSession as dbGetSession,
  loadMessages as dbLoadMessages,
} from "../session-store.js";
import { getProject } from "../project-store.js";
import { touchTask } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { createCustomTools } from "../tools/index.js";
import type { CreateSessionOpts } from "../tools/delegate.js";
import {
  createAgentRuntime,
  ModelNotFoundError,
  type CreateAgentRuntimeParams,
  type RuntimeSessionTools,
} from "./registry.js";
import { getSetting } from "../settings-store.js";
import { parseThinkingLevel } from "../models/model-settings.js";
import { attachRuntimeBroadcastObserver } from "./runtime-broadcast-observer.js";
import { attachRuntimePersistenceObserver } from "./runtime-persistence-observer.js";

function createSessionFactory(state: ServerState) {
  return (projectId: number, projectDir: string, opts?: CreateSessionOpts) =>
    createNewSession(state, projectId, projectDir, opts);
}

function resolveSessionTools(params: {
  state: ServerState;
  projectId: number;
  sessionId: string;
  taskId: number | null;
}): RuntimeSessionTools {
  const { state, projectId, sessionId, taskId } = params;
  const createSession = createSessionFactory(state);

  const broadcast = createBroadcast(state.clients);
  const includeDelegateTool = !!taskId;

  const customTools = createCustomTools({
    projectId,
    sessionId,
    taskId,
    broadcast,
    sessions: state.sessions,
    createSession,
    delegate: includeDelegateTool
      ? {
          sessionId,
          deleteSession: (id) => state.sessions.delete(id),
        }
      : undefined,
  });

  return {
    builtins: ["read", "write", "edit", "bash"],
    customTools,
  };
}


async function createManagedSessionRuntime(params: {
  state: ServerState;
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
    state,
    runtimeType,
    projectId,
    projectDir,
    sessionId,
    taskId,
    model,
    thinkingLevel,
    resume,
  } = params;

  const sessionTools = resolveSessionTools({
    state,
    projectId,
    sessionId,
    taskId,
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

  const detachRuntimeBroadcastObserver = attachRuntimeBroadcastObserver({
    sessionId,
    projectId,
    runtime,
    clients: state.clients,
  });
  const detachRuntimePersistenceObserver = attachRuntimePersistenceObserver({
    sessionId,
    runtime,
  });

  let observersDetached = false;
  const detachRuntimeObservers = () => {
    if (observersDetached) return;
    observersDetached = true;
    detachRuntimeBroadcastObserver();
    detachRuntimePersistenceObserver();
  };

  const originalClose = runtime.close.bind(runtime);
  runtime.close = async () => {
    detachRuntimeObservers();
    return originalClose();
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
function resolveRuntimeTypeForModel(model: { provider: string; modelId: string } | null | undefined): string {
  if (model?.provider === "claude_agent_sdk") return "claude_agent_sdk";
  return "pi";
}

export async function createNewSession(
  state: ServerState,
  projectId: number,
  projectDir: string,
  opts?: CreateSessionOpts,
): Promise<ManagedSession> {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const sessionId = crypto.randomUUID();

  const defaultModel = getSetting("default_model");
  const selectedCreateModel = opts?.model
    ?? (defaultModel && {
      provider: defaultModel.provider,
      modelId: defaultModel.modelId,
    });
  const runtimeType = opts?.model
    ? resolveRuntimeTypeForModel(opts.model)
    : (defaultModel?.runtimeType ?? "pi");
  const selectedCreateThinkingLevel = opts?.thinkingLevel
    ? parseThinkingLevel(opts.thinkingLevel)
    : defaultModel?.thinkingLevel ?? null;

  dbCreateSession(sessionId, projectId, {
    modelProvider: selectedCreateModel?.provider,
    modelId: selectedCreateModel?.modelId,
    thinkingLevel: selectedCreateThinkingLevel ?? "off",
    agentRuntimeType: runtimeType,
    taskId: opts?.taskId,
    parentSessionId: opts?.parentSessionId,
  });

  let managed: ManagedSession;
  try {
    managed = await createManagedSessionRuntime({
      state,
      runtimeType,
      projectId,
      projectDir,
      sessionId,
      taskId: opts?.taskId ?? null,
      model: selectedCreateModel,
      thinkingLevel: selectedCreateThinkingLevel,
      resume: false,
    });
  } catch (err) {
    dbDeleteSession(sessionId);
    throw err;
  }

  if (opts?.taskId) {
    touchTask(opts.taskId);
  }

  const broadcast = createBroadcast(state.clients);
  broadcast({
    type: "session_created",
    projectId,
    sessionId: managed.id,
    taskId: opts?.taskId ?? null,
  });

  return managed;
}

/**
 * Ensure a session is open in memory.
 */
export async function ensureSessionOpen(
  state: ServerState,
  sessionId: string,
): Promise<ManagedSession> {
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  const row = dbGetSession(sessionId);
  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const project = getProject(row.project_id);
  if (!project) {
    throw new Error(`Project not found: ${row.project_id}`);
  }

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
    state,
    runtimeType: row.agent_runtime_type,
    projectId: row.project_id,
    projectDir: project.path,
    sessionId,
    taskId: row.task_id,
    model: selectedResumeModel,
    thinkingLevel: selectedResumeThinkingLevel,
    resume: hasPersistedMessages,
  });
}
