/** Reins application tools for the native AgentHarness runtime. */

import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";
import { createTaskTool } from "./create-task.js";
import type { SessionInstance } from "../runtimes/session-instance.js";
import { createSearchTool } from "./search.js";
import { createExecuteTool } from "./execute.js";
import type { ReinsApplicationTool } from "./types.js";

export interface CustomToolsOpts {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
  instance: SessionInstance;
}

export function createCustomTools(opts: CustomToolsOpts): ReinsApplicationTool[] {
  return [
    createTaskTool({
      projectId: opts.projectId,
      broadcast: opts.broadcast,
      sessions: opts.sessions,
      instance: opts.instance,
    }),
    createSearchTool(),
    createExecuteTool({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      taskId: opts.taskId,
      broadcast: opts.broadcast,
      sessions: opts.sessions,
      instance: opts.instance,
    }),
  ];
}
