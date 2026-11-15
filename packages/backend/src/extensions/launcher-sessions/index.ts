/**
 * The backend part of the Launcher's sessions extension (docs/features/launcher.md *Sessions*): which sessions the
 * Launcher lists. It uses only the server SDK.
 */

import type { ServerExtension, ServerSdk, SessionInfo, SessionListQuery } from "@reins/sdk/server";
import type { Static } from "@sinclair/typebox";
import { launcherSessionsApi } from "./api.js";

type LauncherSession = Static<typeof launcherSessionsApi.list.output>[number];
type Reads = Pick<ServerSdk, "sessions" | "projects" | "tasks">;

const PAGE = 200;

/** The query's sessions that are not sub-sessions, page by page; `enough` stops early. */
async function topLevel(reins: Reads, query: SessionListQuery, enough?: (found: SessionInfo[]) => boolean): Promise<SessionInfo[]> {
  const found: SessionInfo[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await reins.sessions.list({ ...query, minMessages: 1, limit: PAGE, offset });
    found.push(...page.filter((session) => session.parentSessionId === null));
    if (page.length < PAGE || enough?.(found)) return found;
  }
}

export async function launcherSessions(reins: Reads): Promise<LauncherSession[]> {
  const listed: { session: SessionInfo; project: string; task: string | null }[] = [];
  for (const project of await reins.projects.list()) {
    // A project's list is pinned first, then the latest change: its first conversation is the one to show.
    const [assistant] = await topLevel(reins, { projectId: project.id, taskId: null }, (found) => found.length > 0);
    if (assistant) listed.push({ session: assistant, project: project.name, task: null });
    for (const task of await reins.tasks.list("open", project.id)) {
      for (const session of await topLevel(reins, { projectId: project.id, taskId: task.id })) {
        listed.push({ session, project: project.name, task: task.title });
      }
    }
  }
  return listed
    .toSorted((a, b) => Number(b.session.pinned) - Number(a.session.pinned) || b.session.updatedAt.localeCompare(a.session.updatedAt))
    .map(({ session, project, task }) => ({
      id: session.id,
      name: session.name,
      project,
      task,
      firstMessage: session.firstMessage,
      updatedAt: session.updatedAt,
      activity: session.running ? "running" : session.unread ? "unread" : null,
    }));
}

export const launcherSessionsExtension: ServerExtension = {
  register: (reins) => reins.http.handle(launcherSessionsApi, { list: () => launcherSessions(reins) }),
};
