/**
 * Session Lifecycle & Persistence
 *
 * Manages opening agent sessions backed by SQLite storage.
 * Pi runs with SessionManager.inMemory(); we own persistence.
 */

import {
  createAgentSession,
  createCodingTools,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ServerState, ManagedSession } from "../state.js";
import {
  createAgentRuntime,
  registerRuntimeAdapter,
} from "../runtimes/registry.js";
import { PiRuntimeAdapter } from "../runtimes/pi/adapter.js";
import { PiAgentRuntime, getPiSession } from "../runtimes/pi/runtime.js";
import {
  createSession as dbCreateSession,
  getSession as dbGetSession,
  listSessions as dbListSessions,
  listTaskSessions as dbListTaskSessions,
  persistMessages,
  loadMessages,
  loadMessagesForLLM,
  updateSessionMeta,
  type SessionListItem,
  type SessionRow,
} from "../session-store.js";
import { getTask, touchTask, type TaskRow } from "../task-store.js";
import { createPiRuntimeForCwd } from "./runtime.js";
import { buildReinsSystemPrompt } from "./system-prompt.js";
import { getProject } from "../project-store.js";
import { checkoutBranch } from "../git.js";
import { createCustomTools } from "../tools/index.js";
import type { CreateSessionOpts } from "../tools/delegate.js";
import { createBroadcast, type Broadcast } from "../models/broadcast.js";
import { parseThinkingLevel } from "../models/model-settings.js";
import {
  resolveConfiguredSessionDefaults,
  resolvePersistedSessionDefaults,
  resolveRequestedSessionModel,
} from "./session-models.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensurePiRuntimeRegistered(): void {
  registerRuntimeAdapter(new PiRuntimeAdapter());
}

/**
 * Filter out empty assistant messages with stopReason: "error".
 * These are produced when the LLM call fails entirely (e.g. overloaded_error)
 * and should not be persisted — they poison the conversation context and
 * cause cascading empty responses on subsequent prompts.
 *
 * Assistant messages with actual content are preserved even if they have
 * stopReason: "error" (partial responses from connection resets, etc.).
 */
export function filterErrorMessages(messages: any[]): any[] {
  return messages.filter((m) => {
    if (
      m.role === "assistant" &&
      m.stopReason === "error" &&
      Array.isArray(m.content) &&
      m.content.length === 0
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Populate a SessionManager's entry tree from stored messages.
 * This is needed on resume so that compaction (which reads from
 * SessionManager.getBranch()) sees the conversation history.
 */
export function hydrateSessionManager(sm: any, messages: any[]): void {
  for (const msg of messages) {
    if (msg.role === "compactionSummary") {
      sm.appendCompaction(msg.summary ?? "", sm.getLeafId() ?? "", 0);
    } else {
      sm.appendMessage(msg);
    }
  }
}

/**
 * Resolve a task by ID and check out its branch.
 * Returns null for non-task sessions (no taskId).
 * Throws if a taskId is provided but the task doesn't exist.
 */
async function resolveTask(
  taskId: number | null | undefined,
  projectDir: string,
): Promise<TaskRow | null> {
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  await checkoutBranch(projectDir, task.branch_name);
  return task;
}

type StreamFnLike = (...args: any[]) => unknown;

export function wrapStreamFnWithCwd(
  streamFn: StreamFnLike,
  cwd: string,
): StreamFnLike {
  const wrapped: StreamFnLike = (model, context, options?: Record<string, unknown>) => {
    const mergedOptions = options ? { ...options, cwd } : { cwd };
    return streamFn(model, context, mergedOptions);
  };

  return wrapped;
}

function ensureSessionStreamFnUsesCwd(
  agentSession: { agent: { streamFn: StreamFnLike } },
  cwd: string,
): void {
  const currentStreamFn = agentSession.agent.streamFn;
  if (Reflect.get(currentStreamFn, "__reinsInjectsCwd") === true) return;

  const wrapped = wrapStreamFnWithCwd(currentStreamFn, cwd);
  Reflect.set(wrapped, "__reinsInjectsCwd", true);
  agentSession.agent.streamFn = wrapped;
}

/**
 * Build session options common to both create and resume paths.
 * Sets up tools, session manager, model, and resource loader.
 * Always creates a DefaultResourceLoader with the project's cwd so that
 * skills, extensions, and context files are discovered correctly.
 */
async function buildSessionOpts(params: {
  state: ServerState;
  projectId: number;
  projectDir: string;
  sessionId: string;
  task: TaskRow | null;
  includeDelegateTool: boolean;
  createOpts?: CreateSessionOpts;
  persistedSession?: SessionRow | null;
}) {
  const { state, projectId, projectDir, sessionId, task, includeDelegateTool, createOpts, persistedSession } = params;
  const sessionManager = SessionManager.inMemory();
  const tools = createCodingTools(projectDir);
  const broadcast = createBroadcast(state.clients);
  const createSessionFn = (projId: number, projDir: string, opts?: CreateSessionOpts) =>
    createNewSession(state, projId, projDir, opts);

  const customTools = createCustomTools({
    projectId,
    sessionId,
    taskId: task?.id ?? null,
    broadcast,
    sessions: state.sessions,
    createSession: createSessionFn,
    delegate: includeDelegateTool
      ? {
          sessionId,
          deleteSession: (id) => state.sessions.delete(id),
        }
      : undefined,
  });

  const allTools = [...tools, ...customTools];

  const { authStorage, resourceLoader, modelRegistry } = await createPiRuntimeForCwd({
    cwd: projectDir,
    resourceLoaderOptions: {
      systemPromptOverride: () => buildReinsSystemPrompt({
        tools: allTools,
        task: task ?? undefined,
        isScratchSession: !task,
      }),
    },
  });

  // Resolve model: explicit override → persisted session metadata → DB default → SDK default
  const configuredDefaults = resolveConfiguredSessionDefaults(modelRegistry);
  const persistedDefaults = resolvePersistedSessionDefaults(modelRegistry, persistedSession);
  const requestedModel = resolveRequestedSessionModel(modelRegistry, createOpts);
  const requestedThinkingLevel = createOpts?.thinkingLevel
    ? parseThinkingLevel(createOpts.thinkingLevel)
    : undefined;

  return {
    cwd: projectDir,
    tools,
    customTools,
    sessionManager,
    resourceLoader,
    modelRegistry,
    model: requestedModel
      ?? persistedDefaults.model
      ?? (persistedDefaults.hasPersistedModel ? undefined : configuredDefaults?.model),
    configuredThinkingLevel: requestedThinkingLevel
      ?? persistedDefaults.thinkingLevel
      ?? (persistedDefaults.hasPersistedThinkingLevel ? undefined : configuredDefaults?.thinkingLevel),
    authStorage,
  };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a brand-new session for a project.
 * If opts.taskId is provided, the session is linked to that task and
 * the task's branch is checked out before creating the agent session.
 */
export async function createNewSession(
  state: ServerState,
  projectId: number,
  projectDir: string,
  opts?: CreateSessionOpts,
): Promise<ManagedSession> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const task = await resolveTask(opts?.taskId, projectDir);

  // Generate session ID upfront so we can pass it to the tool factory
  const sessionId = crypto.randomUUID();
  const includeDelegateTool = !!opts?.taskId;

  const sessionOpts = await buildSessionOpts({
    state,
    projectId,
    projectDir,
    sessionId,
    task,
    includeDelegateTool,
    createOpts: opts,
  });

  const result = await createAgentSession(sessionOpts);
  const agentSession = result.session;
  ensureSessionStreamFnUsesCwd(agentSession, projectDir);
  ensurePiRuntimeRegistered();
  const runtime = await createAgentRuntime("pi", { session: agentSession });
  if (!(runtime instanceof PiAgentRuntime)) {
    throw new Error("Runtime adapter returned a non-pi runtime for type 'pi'");
  }

  if (result.extensionsResult.errors.length > 0) {
    console.warn("  Pi extension load errors:", result.extensionsResult.errors);
  }

  if (result.modelFallbackMessage) {
    console.warn(`  Model fallback: ${result.modelFallbackMessage}`);
  }

  if (sessionOpts.configuredThinkingLevel) {
    try {
      agentSession.setThinkingLevel(sessionOpts.configuredThinkingLevel);
    } catch (err) {
      console.warn(
        `  Failed to apply configured thinking level '${sessionOpts.configuredThinkingLevel}' for ${sessionId}:`,
        err,
      );
    }
  }

  // Persist session row using our pre-generated ID
  const model = agentSession.model;
  dbCreateSession(sessionId, projectId, {
    modelProvider: model?.provider,
    modelId: model?.id,
    thinkingLevel: agentSession.thinkingLevel,
    agentRuntimeType: "pi",
    taskId: opts?.taskId,
    parentSessionId: opts?.parentSessionId,
  });

  // Touch task's updated_at
  if (opts?.taskId) {
    touchTask(opts.taskId);
  }

  const managed = wireSession(state, runtime, sessionId, projectId);
  console.log(`  Session created: ${sessionId}${task ? ` (task: ${task.title})` : ""} (total: ${state.sessions.size})`);

  // Notify frontend clients about the new session
  const broadcast = createBroadcast(state.clients);
  broadcast({
    type: "session_created",
    projectId,
    sessionId,
    taskId: opts?.taskId ?? null,
  });

  return managed;
}

/**
 * Resume a session from SQLite: load messages, create in-memory pi session,
 * hydrate with stored messages.
 */
export async function resumeSession(
  state: ServerState,
  sessionId: string,
  projectDir: string,
): Promise<ManagedSession> {
  // Already open?
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  const row = dbGetSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);

  const project = getProject(row.project_id);
  if (!project) throw new Error(`Project not found: ${row.project_id}`);
  const task = await resolveTask(row.task_id, projectDir);

  const includeDelegateTool = !!row.task_id;

  const sessionOpts = await buildSessionOpts({
    state,
    projectId: row.project_id,
    projectDir,
    sessionId,
    task,
    includeDelegateTool,
    persistedSession: row,
  });
  const result = await createAgentSession(sessionOpts);
  ensureSessionStreamFnUsesCwd(result.session, projectDir);
  ensurePiRuntimeRegistered();
  const runtime = await createAgentRuntime("pi", { session: result.session });
  if (!(runtime instanceof PiAgentRuntime)) {
    throw new Error("Runtime adapter returned a non-pi runtime for type 'pi'");
  }

  if (result.extensionsResult.errors.length > 0) {
    console.warn("  Pi extension load errors:", result.extensionsResult.errors);
  }

  const agentSession = result.session;

  if (sessionOpts.configuredThinkingLevel) {
    try {
      agentSession.setThinkingLevel(sessionOpts.configuredThinkingLevel);
    } catch (err) {
      console.warn(
        `  Failed to apply configured thinking level '${sessionOpts.configuredThinkingLevel}' for resumed session ${sessionId}:`,
        err,
      );
    }
  }

  // Load post-compaction messages (from the last compactionSummary onwards).
  // We populate both the SessionManager's entry tree (so compaction can read
  // the conversation via getBranch()) and the agent's LLM context array.
  const messages = loadMessagesForLLM(sessionId);
  if (messages.length > 0) {
    hydrateSessionManager(agentSession.sessionManager, messages);
    agentSession.agent.replaceMessages(messages);
  }

  const managed = wireSession(state, runtime, sessionId, row.project_id);
  console.log(`  Session resumed: ${sessionId} (${messages.length} messages for LLM, total: ${state.sessions.size})`);
  return managed;
}

/**
 * Wire up event subscriptions and register in server state.
 * Shared between create and resume paths.
 */

/**
 * Log SessionManager state at compaction start for debugging empty summaries.
 */
function logCompactionState(sessionId: string, agentSession: any): void {
  try {
    const sm = agentSession.sessionManager;
    const branch = sm.getBranch();
    const entries = branch.map((e: any) => ({
      type: e.type,
      role: e.type === "message" ? e.message?.role : undefined,
      contentPreview: e.type === "message"
        ? JSON.stringify(e.message?.content)?.slice(0, 100)
        : e.type === "compaction"
          ? e.summary?.slice(0, 100)
          : undefined,
    }));
    console.log(`  Compaction starting for ${sessionId}:`);
    console.log(`    SessionManager branch: ${branch.length} entries`);
    console.log(`    Agent messages: ${agentSession.messages?.length ?? "N/A"}`);
    console.log(`    Entries:`, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error(`  Failed to log compaction state for ${sessionId}:`, err);
  }
}

/**
 * Handle a compaction_end event: persist to SQLite and broadcast.
 * Used for both auto-compaction (from pi events) and manual /compact.
 */
function handleCompactionEnd(
  sessionId: string,
  agentSession: any,
  event: { aborted?: boolean; result?: { summary?: string }; errorMessage?: string },
  broadcast: Broadcast,
  projectId: number,
): void {
  if (!event.aborted) {
    try {
      const filtered = filterErrorMessages(agentSession.messages);
      persistMessages(sessionId, filtered);
      console.log(`  Compaction persisted for ${sessionId} (${filtered.length} post-compaction messages)`);
    } catch (err) {
      console.error(`  Failed to persist compaction for ${sessionId}:`, err);
    }
  }
  broadcast({
    type: "event",
    sessionId,
    projectId,
    event: { type: "compaction_end", result: event.result, aborted: event.aborted, errorMessage: event.errorMessage },
  });
}

/**
 * Run a manual compaction with proper start/end events broadcast.
 */
export async function runManualCompaction(
  state: ServerState,
  managed: ManagedSession,
  sessionId: string,
  projectId: number,
  instructions?: string,
): Promise<void> {
  const broadcast = createBroadcast(state.clients);
  broadcast({
    type: "event",
    sessionId,
    projectId,
    event: { type: "compaction_start", reason: "manual" },
  });
  const session = getPiSession(managed.runtime);
  try {
    logCompactionState(sessionId, session);
    const result = await session.compact(instructions);
    handleCompactionEnd(sessionId, session, { result, aborted: false }, broadcast, projectId);
  } catch (err: any) {
    handleCompactionEnd(
      sessionId,
      session,
      { result: undefined, aborted: false, errorMessage: `Manual compaction failed: ${err.message}` },
      broadcast,
      projectId,
    );
    throw err;
  }
}

function wireSession(
  state: ServerState,
  runtime: PiAgentRuntime,
  sessionId: string,
  projectId: number,
): ManagedSession {
  const agentSession = runtime.session;
  const managed: ManagedSession = {
    runtime,
    id: sessionId,
    lastActivity: Date.now(),
  };

  const broadcast = createBroadcast(state.clients);

  runtime.subscribe((event: AgentSessionEvent) => {
    // Intercept pi's auto_compaction_* events and re-emit as our own
    // compaction_start / compaction_end so the frontend gets a unified
    // event regardless of whether compaction was manual or automatic.
    if (event.type === "auto_compaction_start") {
      logCompactionState(sessionId, agentSession);
      broadcast({ type: "event", sessionId, projectId, event: { type: "compaction_start", reason: event.reason ?? "auto" } });
      return;
    }
    if (event.type === "auto_compaction_end") {
      handleCompactionEnd(sessionId, agentSession, event, broadcast, projectId);
      return;
    }

    // Broadcast to all connected WS clients
    broadcast({ type: "event", sessionId, projectId, event });

    // Persist messages after each turn (assistant message + tool results),
    // not just at agent_end. This way we don't lose data if the server
    // restarts mid-conversation.
    if (event.type === "turn_end" || event.type === "agent_end") {
      try {
        const filtered = filterErrorMessages(agentSession.messages);
        persistMessages(sessionId, filtered);

        // Update model/thinking metadata on agent_end
        if (event.type === "agent_end") {
          const model = agentSession.model;
          if (model) {
            updateSessionMeta(sessionId, {
              modelProvider: model.provider,
              modelId: model.id,
              thinkingLevel: agentSession.thinkingLevel,
            });
          }
        }
      } catch (err) {
        console.error(`  Failed to persist messages for ${sessionId}:`, err);
      }
    }
  });

  state.sessions.set(sessionId, managed);
  return managed;
}

/**
 * Ensure a session is open (already in memory or resumed from SQLite).
 */
export async function ensureSessionOpen(
  state: ServerState,
  sessionId: string,
  projectDir: string,
): Promise<ManagedSession> {
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }
  return resumeSession(state, sessionId, projectDir);
}

/**
 * Serialize a live ManagedSession for API responses.
 * Metadata only — persisted chat history is fetched from the dedicated
 * messages endpoint so metadata refreshes cannot clobber in-flight UI state.
 */
export function serializeSession(managed: ManagedSession) {
  const session = getPiSession(managed.runtime);
  const row = dbGetSession(managed.id);
  const messageCount = loadMessages(managed.id).length;
  return {
    id: managed.id,
    task_id: row?.task_id ?? null,
    state: {
      model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      messageCount,
    },
  };
}

/**
 * Serialize a session from SQLite (not currently open in memory).
 */
export function serializeSessionFromDb(sessionId: string) {
  const row = dbGetSession(sessionId);
  if (!row) return null;
  const messageCount = loadMessages(sessionId).length;
  return {
    id: row.id,
    task_id: row.task_id,
    state: {
      model: row.model_provider && row.model_id
        ? { provider: row.model_provider, id: row.model_id }
        : null,
      thinkingLevel: row.thinking_level,
      isStreaming: false,
      messageCount,
    },
  };
}

/**
 * List scratch sessions for a project (from SQLite).
 */
export function serializeSessionList(projectId: number): SessionListItem[] {
  return dbListSessions(projectId);
}

/**
 * List sessions for a task (from SQLite).
 */
export function serializeTaskSessionList(taskId: number): SessionListItem[] {
  return dbListTaskSessions(taskId);
}
