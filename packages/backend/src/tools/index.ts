/**
 * Custom Tools
 *
 * Barrel export for all custom agent tools.
 * Returns a ToolDefinition[] array for use in createAgentSession().
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Broadcast } from "../models/broadcast.js";
import { createTaskTool } from "./create-task.js";

export function createCustomTools(
  projectId: number,
  broadcast: Broadcast,
): ToolDefinition[] {
  return [
    createTaskTool(projectId, broadcast),
  ];
}
