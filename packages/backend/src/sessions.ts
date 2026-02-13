/**
 * Session Lifecycle & Persistence
 *
 * Manages opening agent sessions backed by SQLite storage.
 * Pi runs with SessionManager.inMemory(); we own persistence.
 */

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ServerState, ManagedSession } from "./state.js";
import {
  createSession as dbCreateSession,
  getSession as dbGetSession,
  listSessions as dbListSessions,
  persistMessages,
  replaceAllMessages,
  loadMessages,
  updateSessionMeta,
  type SessionListItem,
} from "./session-store.js";

/**
 * Create a brand-new session for a project.
 */
export async function createNewSession(
  state: ServerState,
  projectId: number,
  projectDir: string,
): Promise<ManagedSession> {
  const sessionManager = SessionManager.inMemory();
  const tools = createCodingTools(projectDir);
  const result = await createAgentSession({
    cwd: projectDir,
    tools,
    sessionManager,
    model: state.explicitModel,
  });

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
  });

  const managed = wireSession(state, agentSession, id);
  console.log(`  Session created: ${id} (total: ${state.sessions.size})`);
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

  const sessionManager = SessionManager.inMemory();
  const tools = createCodingTools(projectDir);
  const result = await createAgentSession({
    cwd: projectDir,
    tools,
    sessionManager,
    model: state.explicitModel,
  });

  const agentSession = result.session;

  // Hydrate with stored messages
  const messages = loadMessages(sessionId);
  if (messages.length > 0) {
    agentSession.agent.replaceMessages(messages);
  }

  const managed = wireSession(state, agentSession, sessionId);
  console.log(`  Session resumed: ${sessionId} (${messages.length} messages, total: ${state.sessions.size})`);
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

  agentSession.subscribe((event: AgentSessionEvent) => {
    // Broadcast to all connected WS clients
    const payload = JSON.stringify({ type: "event", sessionId, event });
    for (const client of state.clients) {
      try { client.ws.send(payload); } catch {}
    }

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
    // summarized version. We need to replace (not append) our stored messages
    // to match, otherwise resume would load the old uncompacted history.
    if (event.type === "auto_compaction_end" && !event.aborted) {
      try {
        replaceAllMessages(sessionId, agentSession.messages);
        console.log(`  Compaction persisted for ${sessionId} (${agentSession.messages.length} messages)`);
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
  return {
    id: managed.id,
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
 * List sessions for a project (from SQLite).
 */
export function serializeSessionList(projectId: number): SessionListItem[] {
  return dbListSessions(projectId);
}
