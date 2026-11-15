/**
 * The Launcher's sessions (docs/features/launcher.md *Sessions*): an item for each session its backend part lists
 * (every open task's sessions, each project's latest session of no task), which opens it in the main area.
 */

import type { Disposer, LauncherItem, ReinsSdk, Activity } from "@reins/sdk";
import type { LauncherSessionsApi } from "@backend/extensions/launcher-sessions/api.js";
import { conversationIcon, paneIcon } from "../../ui/icons.js";

/** The first message is the row's second line: what is past this is cut anyway. */
const DETAIL_LENGTH = 160;
const icon = paneIcon(conversationIcon);

export function registerLauncherSessions(reins: ReinsSdk<LauncherSessionsApi>): Disposer {
  return reins.launcher.items(async () => {
    const sessions = await reins.http.call("list");
    // The app's activity changes at once (a session just opened is read); the answer may be older.
    const known = new Map(reins.sessions.list().map(({ id, activity }) => [id, activity]));
    return sessions.map(({ id, name, project, task, firstMessage, activity }): LauncherItem => {
      const message = firstMessage?.replace(/\s+/g, " ").trim().slice(0, DETAIL_LENGTH);
      const status = statusOf(known.has(id) ? known.get(id) ?? null : activity);
      // A session of no task is known by its own name, as the sidebar shows it; its first message is then the title.
      const title = task ?? (name || message || "Empty session");
      const shown = message && message !== title ? message : null;
      return {
        id: `session:${id}`,
        icon,
        title,
        detail: shown ? `${project} · ${shown}` : project,
        ...(status ? { status } : {}),
        run: () => reins.workspace.open({ view: "session", sessionId: id }, { in: "main" }),
      };
    });
  });
}

function statusOf(activity: Activity | null): LauncherItem["status"] {
  if (activity === "running") return "active";
  if (activity === "unread") return "attention";
  return undefined;
}
