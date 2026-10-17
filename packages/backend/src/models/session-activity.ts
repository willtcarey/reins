/**
 * Whether a session is busy, from the process's open sessions (`sessionBusy`, beside the session store,
 * which derives a row's `running` from them). Reading writes nothing.
 */
import { runningSessionIds, sessionBusy, type SessionRow } from "../session-store.js";
import type { OpenSessions } from "../state.js";

/**
 * Activity of a session:
 *
 * - `running`: its row reads `running` (the store's derivation: busy, or a runtime built before `isBusy`
 *   stored it), or the process has it busy now (`sessionBusy`: its submissions are in progress, its live
 *   runtime is admitting or driving input or applying a run's end, or it is being opened to resume an
 *   operation Pi has in progress): an admitted prompt is busy from its admission, never mistaken for idle.
 * - `idle`: neither. A run an exit cut off is idle, with its operation pending in Pi (the Resume button),
 *   until the next process start resumes it.
 */
export type SessionActivity = "running" | "idle";

export function sessionActivity(row: Pick<SessionRow, "id" | "activity_state">, sessions: OpenSessions): SessionActivity {
  return row.activity_state === "running" || sessionBusy(row.id, sessions) ? "running" : "idle";
}

/** Sessions whose `sessionActivity` is `running`. */
export function activeSessionIds(sessions: OpenSessions): string[] {
  return runningSessionIds(sessions);
}
