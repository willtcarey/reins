/**
 * Session Lifecycle & Serialization
 *
 * Manages opening, finding, and serializing agent sessions.
 * All functions receive ServerState so they don't own it.
 */

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ServerState, ManagedSession } from "./state.js";

/**
 * Open a full AgentSession (with tools, event subscription, etc.).
 * Used for new sessions, continue-recent, and lazy-open on first prompt.
 */
export async function openSession(
  state: ServerState,
  projectDir: string,
  sessionManager: SessionManager,
): Promise<ManagedSession> {
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

  const managed: ManagedSession = {
    session: agentSession,
    id,
    lastActivity: Date.now(),
  };

  // Subscribe to events — broadcast to ALL connected clients with sessionId tag
  agentSession.subscribe((event: AgentSessionEvent) => {
    const payload = JSON.stringify({ type: "event", sessionId: id, event });
    for (const client of state.clients) {
      try { client.ws.send(payload); } catch {}
    }
  });

  state.sessions.set(id, managed);
  console.log(`  Session opened: ${id} (total: ${state.sessions.size})`);
  return managed;
}

/**
 * Find an already-open ManagedSession by its file path.
 */
export function findOpenSession(state: ServerState, sessionPath: string): ManagedSession | null {
  for (const managed of state.sessions.values()) {
    if (managed.session.sessionFile === sessionPath) {
      managed.lastActivity = Date.now();
      return managed;
    }
  }
  return null;
}

/**
 * Read session data from disk (lightweight — no AgentSession created).
 * Returns the same shape as serializeSession() for API consistency.
 */
export function readSessionFromDisk(sessionPath: string) {
  const sm = SessionManager.open(sessionPath);
  const ctx = sm.buildSessionContext();
  return {
    path: sm.getSessionFile(),
    id: sm.getSessionId(),
    messages: ctx.messages,
    state: {
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.modelId } : null,
      thinkingLevel: ctx.thinkingLevel,
      isStreaming: false,
      messageCount: ctx.messages.length,
    },
  };
}

/**
 * Ensure a session is fully open (AgentSession created). If already open,
 * returns the existing ManagedSession. Otherwise opens from sessionPath.
 */
export async function ensureSessionOpen(
  state: ServerState,
  sessionId: string,
  sessionPath: string,
): Promise<ManagedSession> {
  // Already open?
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  // Open from disk
  const sm = SessionManager.open(sessionPath);
  const projectDir = sm.getCwd();
  return openSession(state, projectDir, sm);
}

/**
 * Serialize a live ManagedSession for API responses.
 */
export function serializeSession(managed: ManagedSession) {
  const s = managed.session;
  return {
    path: s.sessionFile,
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
 * List and serialize all sessions for a project directory.
 */
export async function serializeSessionList(projectDir: string) {
  const list = await SessionManager.list(projectDir);
  list.sort((a: any, b: any) => b.modified.getTime() - a.modified.getTime());
  return list.map((s: any) => ({
    path: s.path,
    id: s.id,
    name: s.name,
    created: s.created.toISOString(),
    modified: s.modified.toISOString(),
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
  }));
}
