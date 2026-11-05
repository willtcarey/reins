/**
 * The Recent sessions extension's HTTP API (`reins.http`). Schemas only, so the frontend part imports its type
 * (`RecentSessionsApi`) for `reins.http.call`, and takes a method's output from it (`HttpOutput`). Handled in
 * `index.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const recentSessionsApi = {
  /** The `limit` sessions with the latest activity, of any project, the latest first; a closed task's are left
   * out until a run starts in one after it closed. Each as the sidebar draws it. */
  list: {
    input: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 50 }) }),
    output: Type.Array(Type.Object({
      id: Type.String(),
      /** Its name; null for none (it is then shown by its first message). */
      name: NullableString,
      /** The text of its first message; null before it has one. */
      firstMessage: NullableString,
      /** Its project's name; null for a session of no project. */
      project: NullableString,
      /** Its task's title; null for one of no task. */
      task: NullableString,
      updatedAt: Type.String(),
      activity: Type.Union([Type.Literal("running"), Type.Literal("unread"), Type.Null()]),
    })),
  },
} satisfies HttpApi;

export type RecentSessionsApi = typeof recentSessionsApi;
