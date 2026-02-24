/**
 * Custom Tools
 *
 * Barrel export for all custom agent tools.
 * Returns a ToolDefinition[] array for use in createAgentSession().
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Broadcast } from "../models/broadcast.js";
import { createTaskTool } from "./create-task.js";
import { createDelegateTool, type CreateSessionFn } from "./delegate.js";

export interface CustomToolsOpts {
  projectId: number;
  broadcast: Broadcast;
  /** When set, delegation is available for this session. */
  delegate?: {
    sessionId: string;
    createSession: CreateSessionFn;
    deleteSession: (id: string) => void;
  };
}

export function createCustomTools(opts: CustomToolsOpts): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createTaskTool(opts.projectId, opts.broadcast),
  ];

  // Delegate tool is only available in task sessions
  if (opts.delegate) {
    tools.push(createDelegateTool(opts.delegate.sessionId, opts.delegate.createSession, opts.delegate.deleteSession));
  }

  return tools;
}
