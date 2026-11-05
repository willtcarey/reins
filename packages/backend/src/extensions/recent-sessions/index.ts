/**
 * The Recent sessions extension's backend part (docs/features/sidebar.md *Recent*): which sessions are recent.
 * Recent is the sessions with the latest activity (`updatedAt`), of any project. Closing a task puts its sessions
 * away: one is recent again only once a run starts in it after the task closed. A run that was going when the
 * task closed (an agent closing its own task) ends after, but does not bring it back, as it does not mark it
 * unread. It uses only the server SDK.
 */

import type { Projects, ServerExtension, SessionInfo, Sessions, TaskInfo, Tasks } from "@reins/sdk/server";
import type { Static } from "@sinclair/typebox";
import { recentSessionsApi } from "./api.js";

type RecentSession = Static<typeof recentSessionsApi.list.output>[number];

/** The sessions read at a time, and how many at most before giving up on filling `limit` (a long tail of
 * sessions of closed tasks). */
const PAGE = 50;
const MAX_READ = 500;

/** What it reads of the server SDK. */
export interface RecentReads {
  readonly sessions: Pick<Sessions, "list">;
  readonly projects: Pick<Projects, "get">;
  readonly tasks: Pick<Tasks, "get">;
}

/** Reads each project and task once per answer. */
function cached<T>(read: (id: number) => Promise<T>): (id: number) => Promise<T> {
  const seen = new Map<number, Promise<T>>();
  return (id) => {
    let found = seen.get(id);
    if (!found) seen.set(id, found = read(id));
    return found;
  };
}

function putAway(session: SessionInfo, task: TaskInfo | null): boolean {
  if (task?.closedAt == null) return false;
  return session.lastRunStartedAt === null || session.lastRunStartedAt <= task.closedAt;
}

export async function recentSessions({ sessions, projects, tasks }: RecentReads, limit: number): Promise<RecentSession[]> {
  const task = cached((id) => tasks.get(id));
  const project = cached((id) => projects.get(id));
  const found: RecentSession[] = [];
  for (let offset = 0; found.length < limit && offset < MAX_READ; offset += PAGE) {
    const page = await sessions.list({ limit: PAGE, offset });
    for (const session of page) {
      const itsTask = session.taskId === null ? null : await task(session.taskId);
      if (putAway(session, itsTask)) continue;
      found.push({
        id: session.id,
        name: session.name,
        firstMessage: session.firstMessage,
        project: session.projectId === null ? null : (await project(session.projectId)).name,
        task: itsTask?.title ?? null,
        updatedAt: session.updatedAt,
        activity: session.running ? "running" : session.unread ? "unread" : null,
      });
      if (found.length === limit) break;
    }
    if (page.length < PAGE) break;
  }
  return found;
}

export const recentSessionsExtension: ServerExtension = {
  register: (reins) => reins.http.handle(recentSessionsApi, { list: ({ input }) => recentSessions(reins, input.limit) }),
};
