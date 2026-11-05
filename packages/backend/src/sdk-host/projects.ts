/**
 * `projects` and `tasks` (docs/dev/server-sdk.md *Projects and tasks*), for an extension (`reins.projects`,
 * `reins.tasks`) and an agent's script (`api.projects`, `api.tasks`): any project or task, by its ID. What a
 * script leaves out is its session's (its project, its node); an extension names it.
 */

import { Type } from "@sinclair/typebox";
import type { ProjectInfo, TaskInfo } from "@reins/sdk/server";
import { getProject, listProjects, type Project } from "../project-store.js";
import { getTask, type TaskRow } from "../task-store.js";
import { sdkMethod, type CallContext, type SdkNamespace } from "./declaration.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ProjectSchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  baseBranch: Type.String({ description: "The branch its tasks' branches start from and its diffs compare with." }),
  defaultSourceId: Type.Union([Type.Number(), Type.Null()], { description: "Its default source: where it was created, where a new session of it works unless told otherwise." }),
  createdAt: Type.String(),
  lastOpenedAt: Type.String(),
});

const TaskStatusSchema = Type.Union([Type.Literal("open"), Type.Literal("closed")]);

export const TaskSchema = Type.Object({
  id: Type.Number(),
  projectId: Type.Number(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  branchName: Type.String(),
  baseCommit: Type.Union([Type.String(), Type.Null()]),
  status: TaskStatusSchema,
  closedAt: Type.Union([Type.String(), Type.Null()], { description: "When it was closed; null while it is open." }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const ProjectIdParam = Type.Union([Type.Number(), Type.Literal("current")], { description: "The project: the caller's when left out or \"current\"." });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function projectInfo(project: Project): ProjectInfo {
  return {
    id: project.id,
    name: project.name,
    baseBranch: project.base_branch,
    defaultSourceId: project.default_source_id,
    createdAt: project.created_at,
    lastOpenedAt: project.last_opened_at,
  };
}

export function taskInfo(task: TaskRow): TaskInfo {
  return {
    id: task.id,
    projectId: task.project_id,
    title: task.title,
    description: task.description,
    branchName: task.branch_name,
    baseCommit: task.base_commit,
    status: task.status,
    closedAt: task.closed_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

function projectRow(projectId: number): Project {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function taskRow(taskId: number): TaskRow {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

/** The ID of project `projectId`, the caller's by default; throws for a session of no project, and for an
 * extension that names none: tasks belong to projects. */
function projectIdOf(context: CallContext, projectId: number | "current" = "current"): number {
  if (projectId !== "current") return projectRow(projectId).id;
  if (context.caller.kind !== "session") throw new Error("An extension names the project: it has no calling session");
  const id = context.caller.session.projectId;
  if (id === null) throw new Error("This session has no project, and tasks belong to projects");
  return id;
}

/** The tasks of the project of task `taskId`, whichever project that is. */
function tasksOfTask(context: CallContext, taskId: number) {
  return context.models.project(taskRow(taskId).project_id).tasks();
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

const projectsList = sdkMethod({
  description: "List all projects.",
  params: [],
  returns: Type.Array(ProjectSchema),
  tags: ["projects", "list", "query", "read"],
  run: async () => listProjects().map(projectInfo),
});

const projectsGet = sdkMethod({
  description: "Get a project by ID. Throws if not found.",
  params: [{ name: "projectId", schema: Type.Number() }],
  returns: ProjectSchema,
  tags: ["projects", "get", "read", "lookup"],
  run: async (_context, projectId) => projectInfo(projectRow(projectId)),
});

const projectsCurrent = sdkMethod({
  description: "Get the current project (the one this session belongs to), or null for a session of no project. No ID needed.",
  params: [],
  returns: Type.Union([ProjectSchema, Type.Null()]),
  tags: ["projects", "current", "read", "self", "context"],
  async run(context) {
    if (context.caller.kind !== "session") throw new Error("projects.current is the calling session's project, and an extension has none");
    const { projectId } = context.caller.session;
    return projectId === null ? null : projectInfo(projectRow(projectId));
  },
});

const projectsCreate = sdkMethod({
  description:
    "Create a new project whose default source is `path` on node `nodeId` (default: the node this session runs on), a directory there. " +
    "Detects the default branch (main, master or develop) there if baseBranch is not given.",
  params: [
    { name: "name", schema: Type.String() },
    { name: "path", schema: Type.String() },
    { name: "baseBranch", schema: Type.String(), optional: true },
    { name: "nodeId", schema: Type.String(), optional: true },
  ],
  returns: ProjectSchema,
  tags: ["projects", "create", "write", "mutation"],
  async run(context, name, path, baseBranch, nodeId) {
    const node = nodeId ?? (context.caller.kind === "session" ? context.caller.session.source.record.node_id : undefined);
    if (!node) throw new Error("An extension names the project's node");
    return projectInfo(await context.models.projects.create({ name, path, nodeId: node, ...(baseBranch === undefined ? {} : { base_branch: baseBranch }) }));
  },
});

export const PROJECTS = {
  name: "projects",
  methods: { list: projectsList, get: projectsGet, create: projectsCreate, current: projectsCurrent },
  types: { Project: ProjectSchema },
} satisfies SdkNamespace;

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

const tasksList = sdkMethod({
  description: "List tasks of a project, the current one unless projectId names another. Open tasks appear before closed ones. Optionally filter by status.",
  params: [
    { name: "status", schema: TaskStatusSchema, optional: true },
    { name: "projectId", schema: ProjectIdParam, optional: true },
  ],
  returns: Type.Array(TaskSchema),
  tags: ["tasks", "list", "query", "read", "filter"],
  run: async (context, status, projectId) => context.models.project(projectIdOf(context, projectId)).tasks().list(status).map(taskInfo),
});

const tasksCurrent = sdkMethod({
  description: "Get the task for the current session. Returns null if this is a scratch session.",
  params: [],
  returns: Type.Union([TaskSchema, Type.Null()]),
  tags: ["tasks", "current", "read", "self", "context"],
  async run(context) {
    const projectId = projectIdOf(context);
    const taskId = context.caller.kind === "session" ? context.caller.session.taskId : null;
    const task = taskId === null ? null : context.models.project(projectId).tasks().get(taskId);
    return task && taskInfo(task);
  },
});

const tasksGet = sdkMethod({
  description: "Get a task by ID, of any project. Throws if not found.",
  params: [{ name: "taskId", schema: Type.Number() }],
  returns: TaskSchema,
  tags: ["tasks", "get", "read", "lookup"],
  run: async (_context, taskId) => taskInfo(taskRow(taskId)),
});

const tasksCreate = sdkMethod({
  description: "Create a new task with a dedicated git branch, in the current project unless projectId names another. Derives the branch name from the title if not given. " +
    "No checkout is touched: its sessions' runs make the branch where they work, adopting one that exists there or on origin.",
  params: [
    { name: "title", schema: Type.String() },
    { name: "description", schema: Type.String() },
    { name: "branchName", schema: Type.String(), optional: true },
    { name: "projectId", schema: ProjectIdParam, optional: true },
  ],
  returns: TaskSchema,
  tags: ["tasks", "create", "write", "branch"],
  run: async (context, title, description, branchName, projectId) =>
    taskInfo(await context.models.project(projectIdOf(context, projectId)).tasks().create({ title, description, branch_name: branchName })),
});

const tasksUpdate = sdkMethod({
  description: "Update a task's title, description and/or baseCommit, in any project. Throws if the task is not found.",
  params: [
    { name: "taskId", schema: Type.Number() },
    {
      name: "updates",
      schema: Type.Object({
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        baseCommit: Type.Optional(Type.String()),
      }),
    },
  ],
  returns: TaskSchema,
  tags: ["tasks", "update", "write", "edit", "baseCommit", "base", "commit"],
  async run(context, taskId, { title, description, baseCommit }) {
    const task = tasksOfTask(context, taskId).update(taskId, {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(baseCommit === undefined ? {} : { base_commit: baseCommit }),
    });
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return taskInfo(task);
  },
});

const tasksClose = sdkMethod({
  description: "Close an open task, of any project. Throws if the task is not found.",
  params: [{ name: "taskId", schema: Type.Number() }],
  returns: TaskSchema,
  tags: ["tasks", "close", "write", "status"],
  run: async (context, taskId) => taskInfo(tasksOfTask(context, taskId).close(taskId)),
});

const tasksReopen = sdkMethod({
  description: "Reopen a closed task, of any project. Throws if the task is not found.",
  params: [{ name: "taskId", schema: Type.Number() }],
  returns: TaskSchema,
  tags: ["tasks", "reopen", "write", "status"],
  run: async (context, taskId) => taskInfo(tasksOfTask(context, taskId).reopen(taskId)),
});

export const TASKS = {
  name: "tasks",
  methods: { list: tasksList, current: tasksCurrent, get: tasksGet, create: tasksCreate, update: tasksUpdate, close: tasksClose, reopen: tasksReopen },
  types: { Task: TaskSchema },
} satisfies SdkNamespace;
