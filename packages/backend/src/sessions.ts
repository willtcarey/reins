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
  applyCompaction,
  loadMessages,
  loadMessagesForLLM,
  updateSessionMeta,
  type SessionListItem,
} from "./session-store.js";
import { getTask, touchTask, type TaskRow } from "./task-store.js";
import { getProject } from "./project-store.js";
import { checkoutBranch } from "./git.js";
import { createCustomTools } from "./tools/index.js";
import { createBroadcast } from "./models/broadcast.js";

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
async function buildSessionOpts(
  state: ServerState,
  projectId: number,
  projectDir: string,
  task: TaskRow | null,
) {
  const sessionManager = SessionManager.inMemory();
  const tools = createCodingTools(projectDir);
  const broadcast = createBroadcast(state.clients);
  const customTools = createCustomTools(projectId, broadcast);

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    appendSystemPromptOverride: (base) => [
      ...base,
      "The bash tool already executes in the current working directory. Do not prefix commands with `cd` to the project root.",
      ...(task ? [buildTaskPromptPrefix(task)] : []),
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

/**
 * Create a brand-new session for a project.
 * If opts.taskId is provided, the session is linked to that task and
 * the task's branch is checked out before creating the agent session.
 */
export async function createNewSession(
  state: ServerState,
  projectId: number,
  projectDir: string,
  opts?: { taskId?: number },
): Promise<ManagedSession> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const task = await resolveTask(opts?.taskId, projectDir);
  const sessionOpts = await buildSessionOpts(state, projectId, projectDir, task);
  const result = await createAgentSession(sessionOpts);
  const agentSession = result.session;
  const id = agentSession.sessionId;

  if (result.modelFallbackMessage) {
    console.warn(`  Model fallback: ${result.modelFallbackMessage}`);
  }

  // Persist session row
  const model = agentSession.model;
  dbCreateSession(id, projectId, {
    modelProvider: model?.provider,
    modelId: model?.id,
    thinkingLevel: agentSession.thinkingLevel,
    taskId: opts?.taskId,
  });

  // Touch task's updated_at
  if (opts?.taskId) {
    touchTask(opts.taskId);
  }

  const managed = wireSession(state, agentSession, id);
  console.log(`  Session created: ${id}${task ? ` (task: ${task.title})` : ""} (total: ${state.sessions.size})`);
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
  const sessionOpts = await buildSessionOpts(state, row.project_id, projectDir, task);
  const result = await createAgentSession(sessionOpts);

  const agentSession = result.session;

  // Hydrate with stored messages (only post-compaction for LLM context)
  const messages = loadMessagesForLLM(sessionId);
  if (messages.length > 0) {
    agentSession.agent.replaceMessages(messages);
  }

  const managed = wireSession(state, agentSession, sessionId);
  console.log(`  Session resumed: ${sessionId} (${messages.length} messages for LLM, total: ${state.sessions.size})`);
  return managed;
}

/**
 * Wire up event subscriptions and register in server state.
 * Shared between create and resume paths.
 */
function wireSession(
  state: ServerState,
  agentSession: any,
  sessionId: string,
): ManagedSession {
  const managed: ManagedSession = {
    session: agentSession,
    id: sessionId,
    lastActivity: Date.now(),
  };

  const broadcast = createBroadcast(state.clients);

  agentSession.subscribe((event: AgentSessionEvent) => {
    // Broadcast to all connected WS clients
    broadcast({ type: "event", sessionId, event });

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

    // After compaction, pi replaces the message array with a shorter
    // summarized version. We preserve all existing messages and append
    // a compaction summary marker + the new compacted messages.
    if (event.type === "auto_compaction_end" && !event.aborted) {
      try {
        applyCompaction(sessionId, agentSession.messages);
        console.log(`  Compaction persisted for ${sessionId} (${agentSession.messages.length} post-compaction messages)`);
      } catch (err) {
        console.error(`  Failed to persist compaction for ${sessionId}:`, err);
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
 */
export function serializeSession(managed: ManagedSession) {
  const s = managed.session;
  // Look up task_id from DB row
  const row = dbGetSession(managed.id);
  return {
    id: managed.id,
    task_id: row?.task_id ?? null,
    messages: s.messages,
    state: {
      model: s.model ? { provider: s.model.provider, id: s.model.id } : null,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      messageCount: s.messages.length,
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
