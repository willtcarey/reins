/**
 * Custom Tools
 *
 * Barrel export for all custom agent tools.
 * Returns a ToolDefinition[] array for use in createAgentSession().
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
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

function widenTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>): ToolDefinition<TSchema, TDetails> {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parsedParams = Value.Parse(tool.parameters, params);
      return tool.execute(toolCallId, parsedParams, signal, onUpdate, ctx);
    },
    renderCall: tool.renderCall
      ? (args, theme) => tool.renderCall!(Value.Parse(tool.parameters, args), theme)
      : undefined,
  };
}

export function createCustomTools(opts: CustomToolsOpts): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    widenTool(createTaskTool({
      projectId: opts.projectId,
      broadcast: opts.broadcast,
      sessions: opts.sessions,
      createSession: opts.createSession,
    })),
    widenTool(createSearchTool()),
    widenTool(createExecuteTool({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      taskId: opts.taskId,
      broadcast: opts.broadcast,
      sessions: opts.sessions,
    })),
  ];

  // Delegate tool is only available in task sessions
  if (opts.delegate) {
    tools.push(widenTool(createDelegateTool(opts.delegate.sessionId, opts.createSession, opts.delegate.deleteSession)));
  }

  return tools;
}
