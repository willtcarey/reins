/**
 * Task API function definitions and schema.
 */

import { Type } from "@sinclair/typebox";
import { ProjectModel } from "../models/projects.js";
import { getProject } from "../project-store.js";
import { getTask, listTasks, updateTask } from "../task-store.js";
import { type ApiFunctionDef, defineFunction } from "./api-registry.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TaskStatusSchema = Type.Union([Type.Literal("open"), Type.Literal("closed")]);

export const TaskSchema = Type.Object({
  id: Type.Number(),
  project_id: Type.Number(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  branch_name: Type.String(),
  base_commit: Type.Union([Type.String(), Type.Null()]),
  status: TaskStatusSchema,
  created_at: Type.String(),
  updated_at: Type.String(),
});

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

export const TASK_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "tasks.list",
    description: "List all tasks for the current project. Open tasks appear before closed ones.",
    parameters: Type.Object({}),
    returns: Type.Array(TaskSchema),
    tags: ["tasks", "list", "query", "read"],
    execute: (_params, ctx) => listTasks(ctx.projectId),
  }),
  defineFunction({
    name: "tasks.current",
    description: "Get the task for the current session. Returns null if this is a scratch session.",
    parameters: Type.Object({}),
    returns: Type.Union([TaskSchema, Type.Null()]),
    tags: ["tasks", "current", "read", "self", "context"],
    execute: (_params, ctx) => (ctx.taskId ? getTask(ctx.taskId) : null),
  }),
  defineFunction({
    name: "tasks.get",
    description: "Get a single task by ID. Throws if not found.",
    parameters: Type.Object({ taskId: Type.Number() }),
    returns: TaskSchema,
    tags: ["tasks", "get", "read", "lookup"],
    execute: (params, _ctx) => {
      const task = getTask(params.taskId);
      if (!task) throw new Error(`Task ${params.taskId} not found`);
      return task;
    },
  }),
  defineFunction({
    name: "tasks.create",
    description: "Create a new task with a dedicated git branch. Derives branch name from title if not provided.",
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
      branchName: Type.Optional(Type.String()),
    }),
    returns: TaskSchema,
    async: true,
    tags: ["tasks", "create", "write", "branch"],
    execute: async (params, ctx) => {
      const project = getProject(ctx.projectId);
      if (!project) throw new Error(`Project ${ctx.projectId} not found`);
      const model = new ProjectModel(ctx.projectId, project.path, project.base_branch, ctx.sessions, ctx.broadcast);
      return model.tasks().create({
        title: params.title,
        description: params.description,
        branch_name: params.branchName,
      });
    },
  }),
  defineFunction({
    name: "tasks.update",
    description: "Update a task's title and/or description. Throws if the task is not found.",
    parameters: Type.Object({
      taskId: Type.Number(),
      updates: Type.Object({
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
      }),
    }),
    returns: TaskSchema,
    tags: ["tasks", "update", "write", "edit"],
    execute: (params, _ctx) => {
      const task = updateTask(params.taskId, params.updates);
      if (!task) throw new Error(`Task ${params.taskId} not found`);
      return task;
    },
  }),
];
