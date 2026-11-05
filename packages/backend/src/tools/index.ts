/** Server-side implementations of the Reins application tools. The tool definitions are a session
 * runtime's (`session-runtime/reins-tools.ts`), which reach these through `ReinsToolCalls`. */

import type { Models } from "../models/models.js";
import type { SessionInstance } from "../sessions/session-instance.js";
import { createTaskForSession, type CreateTaskInput, type CreateTaskResult } from "./create-task.js";
import { searchScriptApi, type ScriptSearchResult } from "./search.js";
import { runScript, type ScriptExecuteResult } from "./execute.js";

/** Session-bound server operations the Reins tools call (`serverToolCalls`). A thrown plain `Error` is a
 * definitive rejection whose message reaches the model. */
export interface ReinsToolCalls {
  executeScript(code: string, signal?: AbortSignal): Promise<ScriptExecuteResult>;
  searchScript(query: string, signal?: AbortSignal): Promise<ScriptSearchResult>;
  createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<CreateTaskResult>;
}

export interface ServerToolScope {
  /** The calling session, read from the server's own row at each call (`Sessions.get`). */
  sessionId: string;
  models: Models;
  /** `create_task`'s start of a session in the task it made. */
  instance?: SessionInstance;
}

/** The three server operations for one session, run in this process. */
export function serverToolCalls({ sessionId, models, instance }: ServerToolScope): ReinsToolCalls {
  return {
    executeScript: async (code, signal) => runScript({ session: models.sessions.get(sessionId), models, signal }, code),
    searchScript: async query => searchScriptApi(query, models.extensions),
    createTask: async input => createTaskForSession({ session: models.sessions.get(sessionId), models, instance }, input),
  };
}
