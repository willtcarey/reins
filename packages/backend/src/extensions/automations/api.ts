/**
 * The automations extension's HTTP API (`reins.http`): `POST /api/extensions/automations/<method>`, the same
 * operations as `api.automations`, for a later Automations tab. Schemas only. Handled in `routes.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";
import { AutomationRunSchema, AutomationSchema, CommandTriggerSchema, ModelParam, ScheduleTriggerSchema, SourceParam } from "./scripting.js";
import type { AutomationView, RunView } from "./store.js";

const Id = Type.Object({ id: Type.Integer({ description: "The automation's ID." }) });
const View = Type.Unsafe<AutomationView>(AutomationSchema);
const Run = Type.Unsafe<RunView>(AutomationRunSchema);
// Over HTTP there is no calling session: a command names its node.
const CommandTrigger = Type.Composite([Type.Omit(CommandTriggerSchema, ["node"]), Type.Object({ node: Type.String() })]);

export const automationsApi = {
  /** Newest first: every one, or those of a session (that it messages or that it made); cancelled ones only when asked. */
  list: {
    input: Type.Object({ sessionId: Type.Optional(Type.String()), includeCancelled: Type.Optional(Type.Boolean()) }),
    output: Type.Array(View),
  },
  /** Its runs, the latest first (404: unknown). */
  runs: { input: Type.Object({ id: Id.properties.id, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), output: Type.Array(Run) },
  /** An automation (400: a bad trigger or a blank message; 404: an unknown session). */
  create: {
    input: Type.Object({
      trigger: Type.Union([ScheduleTriggerSchema, CommandTrigger]),
      message: Type.Optional(Type.String()),
      target: Type.Union([
        Type.Object({ session: Type.String({ description: "The session it messages." }) }),
        Type.Object({ own: Type.Object({ source: SourceParam, model: Type.Optional(ModelParam), compactAboveTokens: Type.Optional(Type.Integer({ minimum: 1 })) }) }),
        Type.Object({ new: Type.Object({ source: SourceParam, model: Type.Optional(ModelParam), background: Type.Optional(Type.Boolean()) }) }),
      ]),
      once: Type.Optional(Type.Boolean()),
      name: Type.Optional(Type.String()),
    }),
    output: View,
  },
  /** Cancels it, by the user (404: unknown). */
  cancel: { input: Id, output: View },
  /** Its next delivery starts a new own session (400: one that messages a session it was given). */
  replaceSession: { input: Id, output: View },
} satisfies HttpApi;

export type AutomationsApi = typeof automationsApi;
