/**
 * create_task Tool
 *
 * Custom agent tool that lets the agent create new tasks from within
 * a conversation. Uses the task model layer for branch creation and
 * WS broadcast.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TaskRow } from "../task-store.js";
import type { Broadcast } from "../models/broadcast.js";
import { createTaskWithBranch } from "../models/tasks.js";
import { getProject } from "../project-store.js";

const parameters = Type.Object({
  title: Type.String({ description: "Concise task title (imperative mood, e.g. \"Add dark mode support\")" }),
  description: Type.String({ description: "Brief description with actionable detail (1-3 sentences)" }),
  branch_name: Type.Optional(
    Type.String({ description: "Git branch name in task/<slug> format. If omitted, derived from the title." }),
  ),
});

/**
 * Factory that creates the create_task tool definition.
 * Loads the project record at execution time so that changes to the
 * project path or base branch are picked up mid-conversation.
 */
export function createTaskTool(
  projectId: number,
  broadcast: Broadcast,
): ToolDefinition {
  return {
    name: "create_task",
    label: "Create Task",
    description:
      "Create a new task for the current project with a dedicated git branch. " +
      "Only use this when the user explicitly asks you to create a task — do not proactively create tasks.",
    parameters,

    async execute(_toolCallId, params) {
      try {
        const project = getProject(projectId);
        if (!project) throw new Error(`Project ${projectId} not found`);

        const task: TaskRow = await createTaskWithBranch(
          projectId,
          project.path,
          project.base_branch,
          {
            title: params.title,
            description: params.description,
            branch_name: params.branch_name,
          },
          broadcast,
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          details: task,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          details: null,
        };
      }
    },
  };
}
