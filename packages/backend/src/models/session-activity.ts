/**
 * Whether a session is busy: the session row's `activity_state` (maintained from its runtime's lifecycle
 * reports by `sessions/session-runs.ts`) and the process's live runtimes. Reading writes nothing.
 */
import { getDb } from "../db.js";
import type { SessionRow } from "../session-store.js";
import type { OpenSessions } from "../state.js";

/**
 * Activity of a session:
 *
 * - `running`: `activity_state` is `running` (from the run's `started` report until its settlement), or
 *   the session's submissions are in progress or its live runtime is admitting or driving input whose
 *   start has not been applied yet: an admitted prompt is busy from its admission, never mistaken for idle.
 * - `idle`: neither.
 *
 * A run interrupted by a process exit stays `running` until the next process start resumes or settles it.
 */
export type SessionActivity = "running" | "idle";

export function sessionActivity(row: Pick<SessionRow, "id" | "activity_state">, sessions: OpenSessions): SessionActivity {
  if (row.activity_state === "running") return "running";
  return runtimeBusy(row.id, sessions) ? "running" : "idle";
}

/** Sessions whose `sessionActivity` is `running`. */
export function activeSessionIds(sessions: OpenSessions): string[] {
  const running = getDb().query<{ id: string }, []>("SELECT id FROM sessions WHERE activity_state = 'running'").all().map(row => row.id);
  const busy = [...new Set([...sessions.submissions.keys(), ...sessions.live.keys()])].filter(id => runtimeBusy(id, sessions));
  return [...new Set([...running, ...busy])];
}

function runtimeBusy(sessionId: string, sessions: OpenSessions): boolean {
  return sessions.submissions.has(sessionId) || (sessions.live.get(sessionId)?.runtime.isStreaming() ?? false);
}
