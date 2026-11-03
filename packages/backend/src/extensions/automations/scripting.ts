/**
 * `api.automations`, the automations extension's scripting functions (`reins.scripting`): wake-ups of the
 * calling session and heartbeats on hidden sessions (docs/features/automations.md).
 */

import { Type, type Static, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import type { ScriptContext, ScriptFunction, ScriptType, Sessions } from "@reins/sdk/server";
import type { Automations } from "./automations.js";

function scriptFunction<P extends TObject<TProperties>, R extends TSchema>(def: {
  name: string;
  description: string;
  parameters: P;
  returns: R;
  async?: boolean;
  tags: string[];
  execute: (params: Static<P>, context: ScriptContext) => Static<R> | Promise<Static<R>>;
}): ScriptFunction {
  return def;
}

const nullable = <T extends TSchema>(schema: T, description?: string) => Type.Union([schema, Type.Null()], description ? { description } : {});

export const ScheduleParam = Type.String({
  description: "When it is due: an interval (\"5m\", \"1h\", \"every 1h30m\"; at least 1m), \"daily HH:MM\", \"weekdays HH:MM\" or a five-field cron expression (\"0 9 * * 1-5\"). Due times are checked every 30 s.",
});
export const TimezoneParam = Type.String({ description: "An IANA timezone for daily and cron times, e.g. \"Europe/London\". Default: the server's." });
export const LocationSchema = Type.Object({ nodeId: Type.String(), path: Type.String({ description: "An absolute directory on the node." }) });
export const SourceParam = Type.Union([Type.Integer({ description: "A source's ID." }), LocationSchema], {
  description: "Where its session works. Default: the calling session's source (its directory), with no project.",
});
export const ModelParam = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.Union([
    Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ])),
}, { description: "Its session's model. Default: the default model setting's." });

const RunOutcomeSchema = Type.Union([
  Type.Literal("sent"), Type.Literal("skipped"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("lost"),
], {
  description: "sent: a wake-up's message was delivered. skipped: its session was busy when it was due. running, completed, failed, cancelled: a heartbeat's run. " +
    "lost: a heartbeat's run whose end Reins did not hear (it reloaded meanwhile).",
});

export const AutomationRunSchema = Type.Object({
  id: Type.Integer(),
  automationId: Type.Integer(),
  sessionId: nullable(Type.String()),
  outcome: RunOutcomeSchema,
  startedAt: Type.String(),
  endedAt: nullable(Type.String()),
  output: nullable(Type.String(), "A heartbeat's run: its final reply."),
  error: nullable(Type.String(), "Why it failed."),
  compaction: nullable(Type.Union([Type.Literal("pending"), Type.Literal("started"), Type.Literal("failed")]), "After a run that left the context above compactAboveTokens."),
  compactionError: nullable(Type.String()),
});

export const AutomationSchema = Type.Object({
  id: Type.Integer({ description: "What automations.cancel and automations.runs take." }),
  kind: Type.Union([Type.Literal("wake"), Type.Literal("heartbeat")]),
  name: nullable(Type.String(), "A heartbeat's name."),
  sessionId: nullable(Type.String(), "A wake-up: the session it messages. A heartbeat: its hidden session (null once replaced, until its next run)."),
  createdBySessionId: nullable(Type.String()),
  message: Type.String({ description: "A wake-up's message, or a heartbeat's prompt." }),
  schedule: Type.String(),
  timezone: Type.String(),
  source: nullable(Type.Union([Type.Integer(), LocationSchema]), "A heartbeat's: where its session works."),
  model: nullable(ModelParam),
  compactAboveTokens: nullable(Type.Integer()),
  nextRunAt: nullable(Type.String(), "When it is next due (UTC); null once cancelled."),
  createdAt: Type.String(),
  cancelledAt: nullable(Type.String()),
  cancelReason: nullable(Type.String(), "Who cancelled it, or that its session was archived or deleted."),
  lastRun: nullable(AutomationRunSchema),
  consecutiveFailures: Type.Integer({ description: "How many of its latest runs failed in a row." }),
});

const idParam = Type.Integer({ description: "The automation's ID." });

/** The functions over `automations`; `sessions` reads the calling session's source. */
export function automationsScripting(automations: Automations, sessions: Pick<Sessions, "get">): { functions: ScriptFunction[]; types: ScriptType[] } {
  const wake = scriptFunction({
    name: "automations.wake",
    description:
      "Wake this session up on a schedule: `message` is sent to it, as a message from the automations extension, each time the schedule is due, " +
      "until it is cancelled (no expiry). Use it to monitor something (\"check PR 42 until it merges\"): each wake-up, check, report, and cancel it " +
      "with automations.cancel(id) once done. A wake-up due while this session is busy is skipped, not queued. Archiving or deleting the session " +
      "cancels it. Each message ends with a note of its ID.\n\n" +
      "  return await api.automations.wake({ schedule: \"10m\", message: \"Check whether PR 42 has merged; if it has, tell me and cancel this wake-up.\" });",
    parameters: Type.Object({
      wakeUp: Type.Object({ schedule: ScheduleParam, message: Type.String({ description: "What it sends each time." }), timezone: Type.Optional(TimezoneParam) }),
    }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "wake", "wake up", "schedule", "monitor", "poll", "remind", "timer", "interval", "later", "watch", "until"],
    execute: ({ wakeUp }, context) => automations.wake({ ...wakeUp, sessionId: context.sessionId }),
  });

  const heartbeat = scriptFunction({
    name: "automations.heartbeat",
    description:
      "Run a prompt on a schedule (\"every morning, summarise my new GitHub notifications\"), on a hidden session of its own that is kept across " +
      "runs, so each run sees what earlier runs found. It starts that session now, with the prompt's first run, and prompts it again each time the " +
      "schedule is due (skipped while the previous run still runs). Each run's final reply is its output: automations.runs(id). The session works " +
      "in the calling session's directory by default, with no project. compactAboveTokens compacts the session after a run that leaves its context " +
      "above that many tokens (the model also compacts by itself near its limit). It runs until cancelled.\n\n" +
      "  return await api.automations.heartbeat({ name: \"GitHub notifications\", schedule: \"daily 09:00\", timezone: \"Europe/London\",\n" +
      "    prompt: \"List my new GitHub notifications since the last run, most important first.\" });",
    parameters: Type.Object({
      heartbeat: Type.Object({
        schedule: ScheduleParam,
        prompt: Type.String({ description: "What each run is asked." }),
        name: Type.Optional(Type.String({ description: "Its name, also its session's." })),
        timezone: Type.Optional(TimezoneParam),
        source: Type.Optional(SourceParam),
        model: Type.Optional(ModelParam),
        compactAboveTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Compact its session after a run that leaves the context above this." })),
      }),
    }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "heartbeat", "schedule", "daily", "cron", "recurring", "every", "morning", "background", "routine", "report"],
    execute: async ({ heartbeat: request }, context) => automations.heartbeat({
      ...request,
      source: request.source ?? (await sessions.get(context.sessionId)).source.id,
      createdBySessionId: context.sessionId,
    }),
  });

  const cancel = scriptFunction({
    name: "automations.cancel",
    description: "Cancel a wake-up or heartbeat for good: it is not due again. Its runs stay readable. Cancelling one already cancelled changes nothing.",
    parameters: Type.Object({ id: idParam }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "cancel", "stop", "wake", "heartbeat", "unschedule", "remove"],
    execute: ({ id }, context) => automations.cancel(id, `Cancelled by session ${context.sessionId}`),
  });

  const list = scriptFunction({
    name: "automations.list",
    description: "This session's wake-ups and the heartbeats it made, newest first; all of them with `all: true`. Cancelled ones only with `includeCancelled: true`.",
    parameters: Type.Object({
      filter: Type.Optional(Type.Object({ all: Type.Optional(Type.Boolean()), includeCancelled: Type.Optional(Type.Boolean()) })),
    }),
    returns: Type.Array(AutomationSchema),
    async: true,
    tags: ["automations", "list", "wake", "heartbeat", "scheduled", "read"],
    execute: ({ filter = {} }, context) => automations.list({
      ...(filter.all ? {} : { sessionId: context.sessionId }),
      ...(filter.includeCancelled === undefined ? {} : { includeCancelled: filter.includeCancelled }),
    }),
  });

  const runs = scriptFunction({
    name: "automations.runs",
    description: "A wake-up's or heartbeat's runs, the latest first (20 by default, at most 100): when each started and ended, its outcome, and a heartbeat run's output (its final reply) or error.",
    parameters: Type.Object({ id: idParam, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    returns: Type.Array(AutomationRunSchema),
    async: true,
    tags: ["automations", "runs", "history", "output", "result", "heartbeat", "failures", "read"],
    execute: ({ id, limit }) => automations.runs(id, limit),
  });

  const replaceSession = scriptFunction({
    name: "automations.replaceSession",
    description: "Give a heartbeat a new session: its next run starts a new hidden session (the old one is kept, hidden). For a heartbeat whose session is broken or whose context went wrong.",
    parameters: Type.Object({ id: idParam }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "heartbeat", "replace", "reset", "new session", "broken", "fix"],
    execute: ({ id }) => automations.replaceSession(id),
  });

  return {
    functions: [wake, heartbeat, cancel, list, runs, replaceSession],
    types: [
      { name: "Automation", schema: AutomationSchema },
      { name: "AutomationRun", schema: AutomationRunSchema },
    ],
  };
}
