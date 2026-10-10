/** Server-side implementations of the Reins application tools. The tool definitions live on the node
 * (`runtime/reins-tools.ts` in the node package), which reach these over `script.execute`, `script.search` and
 * `project.createTask`. */

import type { ReinsToolCalls } from "@reins/node-protocol";
import type { Broadcast } from "../models/broadcast.js";
import type { Models } from "../models/models.js";
import type { ApiContext } from "../scripting/define-function.js";
import type { NodeHub } from "../state.js";
import { getSession } from "../session-store.js";
import { createTaskForSession } from "./create-task.js";
import { searchScriptApi } from "./search.js";
import { runScript } from "./execute.js";

export interface ServerToolScope {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  /** The session's source. */
  sourceId: number;
  broadcast: Broadcast;
  nodes: NodeHub;
  models: Models;
  /** Server-side session operations for `sessions.*` scripts and task session starts. */
  instance?: ApiContext["instance"];
}

/** Project/task/source scope comes from the server's own session row, never from the caller. */
export function sessionToolScope(sessionId: string): { projectId: number; taskId: number | null; sourceId: number } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  return { projectId: row.project_id, taskId: row.task_id, sourceId: row.source_id };
}

/** The three server operations for one session, run in this process. */
export function serverToolCalls(scope: ServerToolScope): ReinsToolCalls {
  const { projectId, sessionId, taskId, sourceId, broadcast, nodes, models, instance } = scope;
  return {
    executeScript: async (code, signal) => runScript({ projectId, sessionId, taskId, sourceId, broadcast, nodes, models, instance, signal }, code),
    searchScript: async query => searchScriptApi(query),
    createTask: input => createTaskForSession({ projectId, sourceId, models, instance }, input),
  };
}
