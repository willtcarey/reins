/**
 * create_task Tool
 *
 * Custom agent tool that lets the agent create new tasks from within
 * a conversation. Uses the task model layer for branch creation and
 * WS broadcast.
 *
 * Optionally accepts a `prompt` parameter to kick off an initial session
 * on the newly created task (fire-and-forget). The tool returns the task
 * info immediately; the session runs in the background. The user watches
 * progress via WS broadcast.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TaskRow } from "../task-store.js";
import type { Broadcast } from "../models/broadcast.js";
import type { CreateSessionFn } from "./delegate.js";
import { ProjectModel } from "../models/projects.js";
import { getProject } from "../project-store.js";
import type { ManagedSession } from "../state.js";

const parameters = Type.Object({
  title: Type.String({ description: "Concise task title (imperative mood, e.g. \"Add dark mode support\")" }),
  description: Type.String({ description: "Brief description with actionable detail (1-3 sentences)" }),
  branch_name: Type.Optional(
    Type.String({ description: "Git branch name in task/<slug> format. If omitted, derived from the title." }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Optional initial prompt to kick off a session on the new task. " +
        "The session starts in the background (fire-and-forget) — the tool returns immediately. " +
        "Use this to start work on the task right away.",
    }),
  ),
});

export interface CreateTaskToolOpts {
  projectId: number;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
  /** When set, the tool can kick off sessions on newly created tasks. */
  createSession?: CreateSessionFn;
}

/**
 * Factory that creates the create_task tool definition.
 * Loads the project record at execution time so that changes to the
 * project path or base branch are picked up mid-conversation.
 */
export function createTaskTool(opts: CreateTaskToolOpts): ToolDefinition {
  const { projectId, broadcast, sessions, createSession } = opts;

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

        const projectModel = new ProjectModel(projectId, project.path, project.base_branch, sessions, broadcast);
        const task: TaskRow = await projectModel.tasks().create({
          title: params.title,
          description: params.description,
          branch_name: params.branch_name,
        });

        // Fire-and-forget: kick off a session on the new task if a prompt was provided.
        // Intentionally not awaited — the tool returns task info immediately.
        if (params.prompt && createSession) {
          createSession(projectId, project.path, { taskId: task.id })
            .then((managed) => {
              managed.session.prompt(params.prompt).catch((err: any) => {
                console.error(`  Failed to prompt task session ${managed.id}:`, err);
              });
            })
            .catch((err: any) => {
              console.error(`  Failed to create session for task ${task.id}:`, err);
            });
        }

        const result: TaskRow & { _note?: string } = { ...task };
        if (params.prompt) {
          result._note = createSession
            ? "Session started in background — watch for progress via WebSocket events."
            : "Prompt was provided but session creation is not available in this context.";
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
