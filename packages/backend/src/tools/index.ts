/** Server-side implementations of the Reins application tools. The tool definitions live on the node
 * (`@reins/node/reins-tools`); node-owned sessions reach these over `script.execute`, `script.search`
 * and `project.createTask`, and legacy server-owned sessions call them in-process. */

import { createReinsTools, type ReinsToolCalls } from "@reins/node/reins-tools";
import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";
import type { ApiContext } from "../scripting/define-function.js";
import { getSession } from "../session-store.js";
import { createTaskForSession } from "./create-task.js";
import { searchScriptApi } from "./search.js";
import { runScript } from "./execute.js";
import type { ReinsApplicationTool } from "./types.js";

export interface ServerToolScope {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
  /** Server-side session operations for `sessions.*` scripts and task session starts. */
  instance?: ApiContext["instance"];
}

/** Project/task scope comes from the server's own session row, never from the caller. */
export function sessionToolScope(sessionId: string): { projectId: number; taskId: number | null } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  return { projectId: row.project_id, taskId: row.task_id };
}

/** The three server operations for one session, run in this process. */
export function serverToolCalls(scope: ServerToolScope): ReinsToolCalls {
  const { projectId, sessionId, taskId, broadcast, sessions, instance } = scope;
  return {
    executeScript: async (code, signal) => runScript({ projectId, sessionId, taskId, broadcast, sessions, instance, signal }, code),
    searchScript: async query => searchScriptApi(query),
    createTask: input => createTaskForSession({ projectId, broadcast, sessions, instance }, input),
  };
}

/** Legacy server-owned sessions: the node package's tool definitions over in-process calls. */
export function createCustomTools(scope: ServerToolScope): ReinsApplicationTool[] {
  return createReinsTools(serverToolCalls(scope));
}
