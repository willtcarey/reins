import type { ProjectCreateTaskResult, ScriptExecuteResult, ScriptSearchResult } from "./schema.js";

/** The Reins application tools' model-visible names. The node defines the tools (descriptions and
 * parameter schemas, `@reins/node/reins-tools`); the server serves the operation each one forwards to
 * (`project.createTask`, `script.search`, `script.execute`). */
export const reinsToolNames = { createTask: "create_task", search: "search", execute: "execute" } as const;

export interface CreateTaskInput { title: string; description: string; branchName?: string; prompt?: string }

/** Session-bound server operations the Reins tools call. On the node they cross the connection; the
 * server implements them for a session (`serverToolCalls`). A thrown plain `Error` is a definitive
 * rejection whose message reaches the model. */
export interface ReinsToolCalls {
  executeScript(code: string, signal?: AbortSignal): Promise<ScriptExecuteResult>;
  searchScript(query: string, signal?: AbortSignal): Promise<ScriptSearchResult>;
  createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<ProjectCreateTaskResult>;
}
