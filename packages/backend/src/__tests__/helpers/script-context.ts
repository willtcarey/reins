import { Models } from "../../models/models.js";
import { upsertSource, defaultSource } from "../../node-store.js";
import { createSession, getSession } from "../../session-store.js";
import type { ApiContext } from "../../scripting/define-function.js";
import type { SessionInstance } from "../../sessions/session-instance.js";
import type { AppState } from "../../state.js";
import { SEEDED_NODE_ID } from "./loopback-node.js";

export interface ScriptCaller {
  sessionId?: string;
  /** Its project; left out, a session of no project. */
  projectId?: number;
  taskId?: number | null;
  /** Its source: by default its project's default source, or a scratch directory for a session of no project. */
  sourceId?: number;
  instance?: SessionInstance;
  signal?: AbortSignal;
}

/** A script's context (`ApiContext`) for a calling session on `state`'s models. Its row is made as `caller`
 * says when the test has none (a test needs a database: `useTestDb`). */
export function scriptContext(state: AppState, caller: ScriptCaller = {}): ApiContext {
  const sessionId = callingSession(caller);
  const models = new Models(state);
  return {
    session: models.sessions.get(sessionId),
    models,
    ...(caller.instance ? { instance: caller.instance } : {}),
    ...(caller.signal ? { signal: caller.signal } : {}),
  };
}

/** The calling session's ID, its row made as `caller` says when there is none. */
export function callingSession({ sessionId = "test-session", projectId, taskId, sourceId }: ScriptCaller): string {
  if (getSession(sessionId)) return sessionId;
  const source = sourceId
    ?? (projectId === undefined ? upsertSource(SEEDED_NODE_ID, "/tmp/reins-script-caller").id : defaultSource(projectId)!.id);
  createSession(sessionId, projectId ?? null, { agentRuntimeType: "pi", sourceId: source, ...(taskId == null ? {} : { taskId }) });
  return sessionId;
}
