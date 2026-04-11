import type { ManagedSession } from "../state.js";
import {
  getSession as dbGetSession,
  listSessions as dbListSessions,
  listTaskSessions as dbListTaskSessions,
  loadMessages,
  type SessionListItem,
} from "../session-store.js";
import { getPiSession } from "./pi/runtime.js";

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

export function serializeSessionList(projectId: number): SessionListItem[] {
  return dbListSessions(projectId);
}

export function serializeTaskSessionList(taskId: number): SessionListItem[] {
  return dbListTaskSessions(taskId);
}
