/**
 * Custom Tools
 *
 * Barrel export for all custom agent tools.
 * Returns a ToolDefinition[] array for use in createAgentSession().
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Broadcast } from "../models/broadcast.js";
import { createTaskTool } from "./create-task.js";
import { createDelegateTool, type RunSubSession } from "./delegate.js";

export interface CustomToolsOpts {
  projectId: number;
  broadcast: Broadcast;
  /** When set, the session is a task session and delegation is available. */
  runSubSession?: RunSubSession;
  /** Current delegation depth (default 0). */
  delegateDepth?: number;
}

export function createCustomTools(opts: CustomToolsOpts): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createTaskTool(opts.projectId, opts.broadcast),
  ];

  // Delegate tool is only available in task sessions
  if (opts.runSubSession) {
    tools.push(createDelegateTool(opts.runSubSession, opts.delegateDepth ?? 0));
  }

  return tools;
}
