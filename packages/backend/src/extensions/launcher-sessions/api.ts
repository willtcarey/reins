/**
 * The HTTP API of the Launcher's sessions extension (`reins.http`). Schemas only, so the frontend part imports its
 * type (`LauncherSessionsApi`) for `reins.http.call`. Handled in `index.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const launcherSessionsApi = {
  /** Every open task's sessions and each project's latest session of no task, pinned first, then the latest
   * change. Sub-sessions, archived and background sessions, and sessions with no messages are left out. */
  list: {
    output: Type.Array(Type.Object({
      id: Type.String(),
      /** The name the user gave it; null for none. */
      name: NullableString,
      /** Its project's name. */
      project: Type.String(),
      /** Its task's title; null for a session of no task. */
      task: NullableString,
      firstMessage: NullableString,
      updatedAt: Type.String(),
      activity: Type.Union([Type.Literal("running"), Type.Literal("unread"), Type.Null()]),
    })),
  },
} satisfies HttpApi;

export type LauncherSessionsApi = typeof launcherSessionsApi;
