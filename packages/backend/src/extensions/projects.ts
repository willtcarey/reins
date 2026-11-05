/**
 * The server SDK's `reins.projects` and `reins.tasks` (docs/dev/server-sdk.md *Projects and tasks*): reads of the
 * server's projects and tasks, for an extension that shows or reasons about them.
 */

import type { ProjectInfo, Projects, TaskInfo, Tasks } from "@reins/sdk/server";
import { getProject } from "../project-store.js";
import { getTask } from "../task-store.js";

/** `reins.projects` of an extension. */
export class ExtensionProjects implements Projects {
  async get(projectId: number): Promise<ProjectInfo> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return { id: project.id, name: project.name };
  }
}

/** `reins.tasks` of an extension. */
export class ExtensionTasks implements Tasks {
  async get(taskId: number): Promise<TaskInfo> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { id: task.id, projectId: task.project_id, title: task.title, closedAt: task.closed_at, createdAt: task.created_at, updatedAt: task.updated_at };
  }
}
