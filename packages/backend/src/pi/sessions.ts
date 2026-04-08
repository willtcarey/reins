/**
 * Session Lifecycle & Persistence
 *
 * Manages opening agent sessions backed by SQLite storage.
 * Pi runs with SessionManager.inMemory(); we own persistence.
 */

import { createAgentSession, createCodingTools, SessionManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ServerState, ManagedSession } from "../state.js";
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
import { createDbBackedAuthStorage } from "./auth-storage.js";
import { getProject } from "../project-store.js";
import { checkoutBranch } from "../git.js";
import { createCustomTools } from "../tools/index.js";
import type { CreateSessionOpts } from "../tools/delegate.js";
import { createBroadcast, type Broadcast } from "../models/broadcast.js";
import { type Api, type Model } from "@mariozechner/pi-ai";
import {
  parseThinkingLevel,
  resolveModel,
  resolveModelSettingWithConfig,
  type ThinkingLevel,
} from "../models/model-settings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Build a task system prompt prefix for injection.
 */
function buildTaskPromptPrefix(task: { title: string; description: string | null }): string {
  let prompt = `## Task\nTitle: ${task.title}`;
  if (task.description) {
    prompt += `\nDescription: ${task.description}`;
  }
  prompt += "\n\nYou are working on this task.";
  return prompt;
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

function resolveConfiguredSessionDefaults(): { model: Model<Api>; thinkingLevel: ThinkingLevel } | undefined {
  const configured = resolveModelSettingWithConfig("default_model");
  if (!configured) return undefined;

  return {
    model: configured.model,
    thinkingLevel: configured.config.thinkingLevel,
  };
}

function resolveRequestedSessionModel(opts?: CreateSessionOpts): Model<Api> | undefined {
  if (!opts?.modelProvider && !opts?.modelId) return undefined;
  if (!opts?.modelProvider || !opts?.modelId) {
    throw new Error("Both modelProvider and modelId are required when overriding a session model.");
  }

  const model = resolveModel(opts.modelProvider, opts.modelId);
  if (!model) {
    throw new Error(`Unknown model override: ${opts.modelProvider}/${opts.modelId}`);
  }

  return model;
}

function resolvePersistedSessionDefaults(row?: SessionRow | null): {
  hasPersistedModel: boolean;
  hasPersistedThinkingLevel: boolean;
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
} {
  const hasPersistedModel = !!(row?.model_provider && row?.model_id);
  const model = hasPersistedModel ? resolveModel(row!.model_provider!, row!.model_id!) : undefined;

  const hasPersistedThinkingLevel = typeof row?.thinking_level === "string" && row.thinking_level.length > 0;
  const thinkingLevel = row?.thinking_level && row.thinking_level !== "off"
    ? parseThinkingLevel(row.thinking_level)
    : undefined;

  return {
    hasPersistedModel,
    hasPersistedThinkingLevel,
    model,
    thinkingLevel,
  };
}

/**
 * Resolve the globally configured default model from settings.
 * Returns undefined when no valid default is configured, allowing the pi SDK
 * to fall back to its built-in default.
 */
export function resolveConfiguredModel(): Model<Api> | undefined {
  return resolveModelSettingWithConfig("default_model")?.model;
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

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    appendSystemPromptOverride: (base) => [
      ...base,
      "The bash tool already executes in the current working directory. Do not prefix commands with `cd` to the project root.",
      ...(task
        ? [buildTaskPromptPrefix(task)]
        : [
            "When the user describes a problem or asks a question, focus on analysis and explanation first. Only make code changes when the user clearly indicates they want changes made. Implementation work should go in tasks.",
          ]),
    ],
  });
  await resourceLoader.reload();

  // Resolve model: explicit override → persisted session metadata → DB default → SDK default
  const configuredDefaults = resolveConfiguredSessionDefaults();
  const persistedDefaults = resolvePersistedSessionDefaults(persistedSession);
  const requestedModel = resolveRequestedSessionModel(createOpts);
  const requestedThinkingLevel = createOpts?.thinkingLevel
    ? parseThinkingLevel(createOpts.thinkingLevel)
    : undefined;

  return {
    cwd: projectDir,
    tools,
    customTools,
    sessionManager,
    resourceLoader,
    model: requestedModel
      ?? persistedDefaults.model
      ?? (persistedDefaults.hasPersistedModel ? undefined : configuredDefaults?.model),
    configuredThinkingLevel: requestedThinkingLevel
      ?? persistedDefaults.thinkingLevel
      ?? (persistedDefaults.hasPersistedThinkingLevel ? undefined : configuredDefaults?.thinkingLevel),
    authStorage: createDbBackedAuthStorage(),
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
    taskId: opts?.taskId,
    parentSessionId: opts?.parentSessionId,
  });

  // Touch task's updated_at
  if (opts?.taskId) {
    touchTask(opts.taskId);
  }

  const managed = wireSession(state, agentSession, sessionId, projectId);
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

  const managed = wireSession(state, agentSession, sessionId, row.project_id);
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
  try {
    logCompactionState(sessionId, managed.session);
    const result = await managed.session.compact(instructions);
    handleCompactionEnd(sessionId, managed.session, { result, aborted: false }, broadcast, projectId);
  } catch (err: any) {
    handleCompactionEnd(
      sessionId,
      managed.session,
      { result: undefined, aborted: false, errorMessage: `Manual compaction failed: ${err.message}` },
      broadcast,
      projectId,
    );
    throw err;
  }
}

function wireSession(
  state: ServerState,
  agentSession: any,
  sessionId: string,
  projectId: number,
): ManagedSession {
  const managed: ManagedSession = {
    session: agentSession,
    id: sessionId,
    lastActivity: Date.now(),
  };

  const broadcast = createBroadcast(state.clients);

  agentSession.subscribe((event: AgentSessionEvent) => {
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
  const s = managed.session;
  const row = dbGetSession(managed.id);
  const messageCount = loadMessages(managed.id).length;
  return {
    id: managed.id,
    task_id: row?.task_id ?? null,
    state: {
      model: s.model ? { provider: s.model.provider, id: s.model.id } : null,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
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
