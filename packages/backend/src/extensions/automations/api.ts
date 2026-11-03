/**
 * The automations extension's HTTP API (`reins.http`): `POST /api/extensions/automations/<method>`, the same
 * operations as `api.automations`, for a later Automations tab. Schemas only. Handled in `routes.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";
import { AutomationRunSchema, AutomationSchema, ModelParam, ScheduleParam, SourceParam, TimezoneParam } from "./scripting.js";
import type { AutomationView, RunView } from "./store.js";

const Id = Type.Object({ id: Type.Integer({ description: "The automation's ID." }) });
const View = Type.Unsafe<AutomationView>(AutomationSchema);
const Run = Type.Unsafe<RunView>(AutomationRunSchema);

export const automationsApi = {
  /** Newest first: every one, or those of a session (that it wakes or that it made); cancelled ones only when asked. */
  list: {
    input: Type.Object({ sessionId: Type.Optional(Type.String()), includeCancelled: Type.Optional(Type.Boolean()) }),
    output: Type.Array(View),
  },
  /** Its runs, the latest first (404: unknown). */
  runs: { input: Type.Object({ id: Id.properties.id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), output: Type.Array(Run) },
  /** A wake-up of a session (400: a bad schedule or a blank message; 404: an unknown session). */
  wake: { input: Type.Object({ sessionId: Type.String(), schedule: ScheduleParam, message: Type.String(), timezone: Type.Optional(TimezoneParam) }), output: View },
  /** A heartbeat, its session started now with its first run (400: a bad schedule, or a session that cannot be started). */
  heartbeat: {
    input: Type.Object({
      schedule: ScheduleParam,
      prompt: Type.String(),
      source: SourceParam,
      name: Type.Optional(Type.String()),
      timezone: Type.Optional(TimezoneParam),
      model: Type.Optional(ModelParam),
      compactAboveTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    output: View,
  },
  /** Cancels it, by the user (404: unknown). */
  cancel: { input: Id, output: View },
  /** A heartbeat's next run starts a new session (400: a wake-up). */
  replaceSession: { input: Id, output: View },
} satisfies HttpApi;

export type AutomationsApi = typeof automationsApi;
