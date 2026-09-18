import type { ManagedSession, ServerState } from "../state.js";
import {
  createSession as dbCreateSession,
  deleteSession as dbDeleteSession,
  getSession as dbGetSession,
  updateSessionMeta,
} from "../session-store.js";
import { loadMessages as dbLoadMessages, type ClientPromptContent } from "../messages-store.js";
import { getProject } from "../project-store.js";
import { touchTask } from "../task-store.js";
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
import { expandPrompt } from "./prompt.js";
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

  create(projectId: number, projectDir: string, options?: SessionCreationOptions): Promise<ManagedSession> {
    return createManagedSession(this, projectId, projectDir, options);
  }

  open(sessionId: string): Promise<ManagedSession> {
    return openManagedSession(this, sessionId);
  }
}

function attachPromptExpansion(params: {
  runtime: AgentRuntime;
  sessionId: string;
}): void {
  const { runtime, sessionId } = params;
  const originalPrompt = runtime.prompt.bind(runtime);
  const originalSteer = runtime.steer.bind(runtime);

  const expand = (content: ClientPromptContent): ClientPromptContent => {
    const { expanded } = expandPrompt(content, sessionId);
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

  attachPromptExpansion({ runtime, sessionId });

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
async function createManagedSession(
  manager: SessionManager,
  projectId: number,
  projectDir: string,
  opts?: SessionCreationOptions,
): Promise<ManagedSession> {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

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

  dbCreateSession(sessionId, projectId, {
    modelProvider: selectedCreateModel?.provider,
    modelId: selectedCreateModel?.modelId,
    thinkingLevel: selectedCreateThinkingLevel ?? "off",
    agentRuntimeType: runtimeType,
    taskId: opts?.taskId,
    parentSessionId: opts?.parentSessionId,
  });

  if (opts?.title !== undefined) updateSessionMeta(sessionId, { name: opts.title });

  let managed: ManagedSession;
  try {
    managed = await createManagedSessionRuntime({
      manager,
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

  manager.broadcast({
    type: "session_created",
    projectId,
    sessionId: managed.id,
    taskId: opts?.taskId ?? null,
    parentSessionId: opts?.parentSessionId ?? null,
  });

  return managed;
}

/** Create a brand-new session using the process-scoped manager. */
export function createNewSession(
  state: ServerState,
  projectId: number,
  projectDir: string,
  options?: SessionCreationOptions,
): Promise<ManagedSession> {
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

/** Ensure a session is open using the process-scoped manager. */
export function ensureSessionOpen(state: ServerState, sessionId: string): Promise<ManagedSession> {
  return new SessionManager(state).open(sessionId);
}

async function reopenSession(manager: SessionManager, sessionId: string): Promise<ManagedSession> {
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
    manager,
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
