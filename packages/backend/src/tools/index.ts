/**
 * Custom Tools
 *
 * Barrel export for all custom agent tools.
 * Returns a ToolDefinition[] array for use in createAgentSession().
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";
import { createTaskTool } from "./create-task.js";
import type { CreateSessionFn } from "../runtimes/sessions-manager.js";
import { createSearchTool } from "./search.js";
import { createExecuteTool } from "./execute.js";

export interface CustomToolsOpts {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
  createSession: CreateSessionFn;
  openSession: (sessionId: string) => Promise<ManagedSession>;
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
      createSession: opts.createSession,
      openSession: opts.openSession,
    })),
  ];

  return tools;
}
