/**
 * Session Lifecycle & Persistence
 *
 * Manages opening agent sessions backed by SQLite storage.
 * Pi runs with SessionManager.inMemory(); we own persistence.
 */

import { createAgentSession, createCodingTools, SessionManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ServerState, ManagedSession } from "./state.js";
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
} from "./session-store.js";
import { getTask, touchTask, type TaskRow } from "./task-store.js";
import { getProject } from "./project-store.js";
import { checkoutBranch } from "./git.js";
import { createCustomTools } from "./tools/index.js";
import type { CreateSessionOpts } from "./tools/delegate.js";
import { createBroadcast, type Broadcast } from "./models/broadcast.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
}) {
  const { state, projectId, projectDir, sessionId, task, includeDelegateTool } = params;
  const sessionManager = SessionManager.inMemory();
  const tools = createCodingTools(projectDir);
  const broadcast = createBroadcast(state.clients);
  const createSessionFn = (projectId: number, projectDir: string, opts?: CreateSessionOpts) =>
    createNewSession(state, projectId, projectDir, opts);

  const customTools = createCustomTools({
    projectId,
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

  return {
    cwd: projectDir,
    tools,
    customTools,
    sessionManager,
    resourceLoader,
    model: state.explicitModel,
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
  });

  const result = await createAgentSession(sessionOpts);
  const agentSession = result.session;

  if (result.modelFallbackMessage) {
    console.warn(`  Model fallback: ${result.modelFallbackMessage}`);
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
  });
  const result = await createAgentSession(sessionOpts);

  const agentSession = result.session;

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
 * Handle a compaction_end event: persist to SQLite and broadcast.
 * Used for both auto-compaction (from pi events) and manual /compact.
 */
function handleCompactionEnd(
  sessionId: string,
  agentSession: any,
  event: { aborted?: boolean; result?: { summary?: string }; [k: string]: any },
  broadcast: Broadcast,
  projectId: number,
): void {
  if (!event.aborted) {
    try {
      persistMessages(sessionId, agentSession.messages);
      console.log(`  Compaction persisted for ${sessionId} (${agentSession.messages.length} post-compaction messages)`);
    } catch (err) {
      console.error(`  Failed to persist compaction for ${sessionId}:`, err);
    }
  }
  broadcast({
    type: "event",
    sessionId,
    projectId,
    event: { type: "compaction_end", result: event.result, aborted: event.aborted, errorMessage: (event as any).errorMessage },
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
      broadcast({ type: "event", sessionId, projectId, event: { type: "compaction_start", reason: (event as any).reason ?? "auto" } });
      return;
    }
    if (event.type === "auto_compaction_end") {
      handleCompactionEnd(sessionId, agentSession, event as any, broadcast, projectId);
      return;
    }

    // Broadcast to all connected WS clients
    broadcast({ type: "event", sessionId, projectId, event });

    // Persist messages after each turn (assistant message + tool results),
    // not just at agent_end. This way we don't lose data if the server
    // restarts mid-conversation.
    if (event.type === "turn_end" || event.type === "agent_end") {
      try {
        persistMessages(sessionId, agentSession.messages);

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
 * Uses SQLite messages (full history including compaction markers)
 * rather than pi's in-memory array (which only has post-compaction messages).
 */
export function serializeSession(managed: ManagedSession) {
  const s = managed.session;
  const row = dbGetSession(managed.id);
  const messages = loadMessages(managed.id);
  return {
    id: managed.id,
    task_id: row?.task_id ?? null,
    messages,
    state: {
      model: s.model ? { provider: s.model.provider, id: s.model.id } : null,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      messageCount: messages.length,
    },
  };
}

/**
 * Serialize a session from SQLite (not currently open in memory).
 */
export function serializeSessionFromDb(sessionId: string) {
  const row = dbGetSession(sessionId);
  if (!row) return null;
  const messages = loadMessages(sessionId);
  return {
    id: row.id,
    task_id: row.task_id,
    messages,
    state: {
      model: row.model_provider && row.model_id
        ? { provider: row.model_provider, id: row.model_id }
        : null,
      thinkingLevel: row.thinking_level,
      isStreaming: false,
      messageCount: messages.length,
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
