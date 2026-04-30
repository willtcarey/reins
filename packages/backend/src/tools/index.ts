/**
 * Custom Tools
 *
 * Barrel export for all custom agent tools.
 * Returns a ToolDefinition[] array for use in createAgentSession().
 */

import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";
import { createTaskTool } from "./create-task.js";
import { createDelegateTool, type CreateSessionFn } from "./delegate.js";
import { createSearchTool } from "./search.js";
import { createExecuteTool } from "./execute.js";

export interface CustomToolsOpts {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
  /** Session creation function — used by create_task (prompt) and delegate. */
  createSession: CreateSessionFn;
  /** When set, delegation is available for this session. */
  delegate?: {
    sessionId: string;
    deleteSession: (id: string) => void;
  };
}

export function createCustomTools(opts: CustomToolsOpts): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool(createTaskTool({
      projectId: opts.projectId,
      broadcast: opts.broadcast,
      sessions: opts.sessions,
      createSession: opts.createSession,
    })),
    defineTool(createSearchTool()),
    defineTool(createExecuteTool({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      taskId: opts.taskId,
      broadcast: opts.broadcast,
      sessions: opts.sessions,
    })),
  ];

  // Delegate tool is only available in task sessions
  if (opts.delegate) {
    tools.push(defineTool(createDelegateTool(opts.delegate.sessionId, opts.createSession, opts.delegate.deleteSession)));
  }

  return tools;
}
