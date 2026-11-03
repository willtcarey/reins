/**
 * `api.automations`, the automations extension's scripting functions (`reins.scripting`): automations that wake
 * the calling session or a hidden session of their own, on a schedule or when a command succeeds
 * (docs/features/automations.md).
 */

import { Type, type Static, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import type { ScriptContext, ScriptFunction, ScriptType, Sessions } from "@reins/sdk/server";
import { InvalidAutomationError, MAX_CHECK_TIMEOUT_MS, type Automations, type TriggerRequest } from "./automations.js";

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
  description: "An interval (\"5m\", \"1h\", \"every 1h30m\"; at least 1m), \"daily HH:MM\", \"weekdays HH:MM\" or a five-field cron expression (\"0 9 * * 1-5\"). Checked every 30 s.",
});
export const TimezoneParam = Type.String({ description: "An IANA timezone for daily and cron times, e.g. \"Europe/London\". Default: the server's." });
export const LocationSchema = Type.Object({ nodeId: Type.String(), path: Type.String({ description: "An absolute directory on the node." }) });
export const SourceParam = Type.Union([Type.Integer({ description: "A source's ID." }), LocationSchema], {
  description: "target \"own\" or \"new\": where its sessions work. Default: the calling session's source (its directory), with no project.",
});
export const ModelParam = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.Union([
    Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ])),
}, { description: "target \"own\" or \"new\": its sessions' model. Default: the default model setting's." });

export const ScheduleTriggerSchema = Type.Object({ schedule: ScheduleParam, timezone: Type.Optional(TimezoneParam) }, { description: "Fires each time the schedule is due." });
export const CommandTriggerSchema = Type.Object({
  command: Type.String({ description: "A bash command, run at each check. Exit code 0 fires; its output (stdout and stderr) goes with the message." }),
  every: Type.String({ description: "How often it is checked: an interval such as \"2m\" (at least 1m)." }),
  node: Type.Optional(Type.String({ description: "The node it runs on, by ID or name. Default: the calling session's." })),
  cwd: Type.Optional(Type.String({ description: "Where it runs. Default: the calling session's directory." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CHECK_TIMEOUT_MS, description: "1 to 600000; 30000 by default. A check that times out is recorded as failed." })),
}, { description: "Fires when the command exits 0. Checking costs no model run: only a firing wakes the session." });

const RunOutcomeSchema = Type.Union([
  Type.Literal("sent"), Type.Literal("skipped"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("lost"),
], {
  description: "sent: delivered to its session. skipped: a schedule whose previous message's run still ran. running, completed, failed, cancelled: a run of its own session. " +
    "failed also: the message could not be sent, or the command could not run. lost: a run whose end Reins did not hear (it reloaded meanwhile).",
});

export const AutomationRunSchema = Type.Object({
  id: Type.Integer(),
  automationId: Type.Integer(),
  sessionId: nullable(Type.String()),
  outcome: RunOutcomeSchema,
  startedAt: Type.String(),
  endedAt: nullable(Type.String()),
  output: nullable(Type.String(), "A run of its own session: its final reply."),
  error: nullable(Type.String(), "Why it failed."),
  exitCode: nullable(Type.Integer(), "A command trigger: the command's exit code when it fired."),
  checkOutput: nullable(Type.String(), "A command trigger: the command's output when it fired."),
  compaction: nullable(Type.Union([Type.Literal("pending"), Type.Literal("started"), Type.Literal("failed")]), "After a run that left the context above compactAboveTokens."),
  compactionError: nullable(Type.String()),
});

export const AutomationSchema = Type.Object({
  id: Type.Integer({ description: "What automations.cancel and automations.runs take." }),
  name: nullable(Type.String()),
  message: nullable(Type.String(), "What it sends when it fires; null: a command's output is the message."),
  target: Type.Union([Type.Literal("session"), Type.Literal("own"), Type.Literal("new")], {
    description: "session: it messages sessionId. own: a hidden session of its own. new: a new session at each delivery (in its runs).",
  }),
  sessionId: nullable(Type.String(), "The session it messages; for target own, its session (null until its first delivery, or once replaced)."),
  createdBySessionId: nullable(Type.String()),
  trigger: Type.Union([
    Type.Object({ kind: Type.Literal("schedule"), schedule: Type.String(), timezone: Type.String() }),
    Type.Object({ kind: Type.Literal("command"), command: Type.String(), every: Type.String(), node: Type.String(), cwd: nullable(Type.String()), timeoutMs: nullable(Type.Integer()) }),
  ]),
  once: Type.Boolean({ description: "Cancelled once it delivered its message." }),
  source: nullable(Type.Union([Type.Integer(), LocationSchema])),
  model: nullable(ModelParam),
  compactAboveTokens: nullable(Type.Integer()),
  background: Type.Boolean({ description: "The sessions it starts are hidden from the session list." }),
  nextRunAt: nullable(Type.String(), "When it is next due or checked (UTC); null once cancelled."),
  checks: Type.Integer({ description: "A command trigger: how many checks did not fire." }),
  lastCheckAt: nullable(Type.String()),
  createdAt: Type.String(),
  cancelledAt: nullable(Type.String()),
  cancelReason: nullable(Type.String(), "Who cancelled it, that it fired once, or that its session was archived or deleted."),
  lastRun: nullable(AutomationRunSchema),
  consecutiveFailures: Type.Integer({ description: "How many of its latest runs failed in a row." }),
});

const idParam = Type.Integer({ description: "The automation's ID." });

/** The functions over `automations`; `sessions` reads the calling session's source and node. */
export function automationsScripting(automations: Automations, sessions: Pick<Sessions, "get">): { functions: ScriptFunction[]; types: ScriptType[] } {
  const create = scriptFunction({
    name: "automations.create",
    description:
      "Wake a session up when a trigger fires, until it is cancelled (or once, with once: true). The message is sent as a message from the automations extension.\n" +
      "- trigger { schedule }: each time it is due (a reminder, a periodic check). Skipped only while the run its previous message started still runs.\n" +
      "- trigger { command, every }: runs the command at each interval and fires when it exits 0. Its output goes with the message, or is the message when there is none. " +
      "Checking costs no model run, so prefer it to a schedule for \"tell me when X happens\" (a PR merged, a deploy finished, a file appeared).\n" +
      "- target \"this\" (default): this session; archiving or deleting it cancels the automation. Keep the ID it returns, to cancel it. " +
      "target \"own\": a hidden session of its own, started at its first delivery and kept, so each run sees what earlier ones found " +
      "(\"every morning, summarise my GitHub notifications\"); each run's final reply is its output (automations.runs). " +
      "target \"new\": a new session at each delivery, shown in the session list (background: true hides it), for work that should start afresh each time " +
      "(\"review each new Dependabot PR\"); a delivery is skipped while the session the previous one started still runs.\n" +
      "A message to a running session joins its run. Cancel with automations.cancel(id).\n\n" +
      "  return await api.automations.create({ trigger: { command: \"gh pr view 42 --json state -q .state | grep -x MERGED\", every: \"2m\" }, once: true,\n" +
      "    message: \"PR 42 has merged: tell the user, then go on with the release notes.\" });\n" +
      "  return await api.automations.create({ trigger: { schedule: \"daily 09:00\", timezone: \"Europe/London\" }, target: \"own\", name: \"GitHub\",\n" +
      "    message: \"List my new GitHub notifications since the last run, most important first.\" });",
    parameters: Type.Object({
      automation: Type.Object({
        trigger: Type.Union([ScheduleTriggerSchema, CommandTriggerSchema]),
        message: Type.Optional(Type.String({
          description: "What it sends when it fires. A command trigger may leave it out: then the command's output is the message, so make the command print what the session should know.",
        })),
        target: Type.Optional(Type.Union([Type.Literal("this"), Type.Literal("own"), Type.Literal("new")], {
          description: "\"this\" (default): this session. \"own\": a hidden session of its own, kept. \"new\": a new session at each delivery.",
        })),
        once: Type.Optional(Type.Boolean({ description: "Cancel it once it delivered its message." })),
        name: Type.Optional(Type.String({ description: "Its name; for target own or new, also its sessions'." })),
        source: Type.Optional(SourceParam),
        model: Type.Optional(ModelParam),
        compactAboveTokens: Type.Optional(Type.Integer({ minimum: 1, description: "target \"own\": compact its session after a run that leaves the context above this many tokens." })),
        background: Type.Optional(Type.Boolean({ description: "target \"new\": hide its sessions from the session list." })),
      }),
    }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "automation", "trigger", "wake", "wake up", "schedule", "monitor", "poll", "watch", "until", "when", "remind", "timer", "interval",
      "daily", "cron", "recurring", "heartbeat", "command", "background", "later"],
    execute: async ({ automation }, context) => {
      const { trigger, target = "this", source, model, compactAboveTokens, background, ...rest } = automation;
      if (target === "this" && (source !== undefined || model !== undefined)) throw new InvalidAutomationError("source and model are for target \"own\" or \"new\"");
      if (target !== "own" && compactAboveTokens !== undefined) throw new InvalidAutomationError("compactAboveTokens is for target \"own\"");
      if (target !== "new" && background !== undefined) throw new InvalidAutomationError("background is for target \"new\": an own session is always hidden");
      const caller = await sessions.get(context.sessionId);
      const resolved: TriggerRequest = "command" in trigger
        ? { ...trigger, node: trigger.node ?? caller.source.nodeId, cwd: trigger.cwd ?? (trigger.node === undefined ? caller.source.path : undefined) }
        : trigger;
      return automations.create({
        ...rest,
        trigger: resolved,
        target: target === "this"
          ? { session: context.sessionId }
          : target === "own"
            ? { own: { source: source ?? caller.source.id, ...(model ? { model } : {}), ...(compactAboveTokens === undefined ? {} : { compactAboveTokens }) } }
            : { new: { source: source ?? caller.source.id, ...(model ? { model } : {}), ...(background === undefined ? {} : { background }) } },
        createdBySessionId: context.sessionId,
      });
    },
  });

  const cancel = scriptFunction({
    name: "automations.cancel",
    description: "Cancel an automation for good: it does not fire again. Its runs stay readable. Cancelling one already cancelled changes nothing.",
    parameters: Type.Object({ id: idParam }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "cancel", "stop", "unschedule", "remove"],
    execute: ({ id }, context) => automations.cancel(id, `Cancelled by session ${context.sessionId}`),
  });

  const list = scriptFunction({
    name: "automations.list",
    description: "The automations that message this session or that it made, newest first; all of them with `all: true`. Cancelled ones only with `includeCancelled: true`.",
    parameters: Type.Object({
      filter: Type.Optional(Type.Object({ all: Type.Optional(Type.Boolean()), includeCancelled: Type.Optional(Type.Boolean()) })),
    }),
    returns: Type.Array(AutomationSchema),
    async: true,
    tags: ["automations", "list", "scheduled", "triggers", "read"],
    execute: ({ filter = {} }, context) => automations.list({
      ...(filter.all ? {} : { sessionId: context.sessionId }),
      ...(filter.includeCancelled === undefined ? {} : { includeCancelled: filter.includeCancelled }),
    }),
  });

  const runs = scriptFunction({
    name: "automations.runs",
    description: "An automation's runs, the latest first (20 by default, at most 100): each delivery (when, its outcome, the command's output when a command fired it, " +
      "and for its own session the run's final reply or error), skip, and check that could not run. Checks that did not fire are only counted (Automation.checks).",
    parameters: Type.Object({ id: idParam, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    returns: Type.Array(AutomationRunSchema),
    async: true,
    tags: ["automations", "runs", "history", "output", "result", "failures", "read"],
    execute: ({ id, limit }) => automations.runs(id, limit),
  });

  const replaceSession = scriptFunction({
    name: "automations.replaceSession",
    description: "Give an automation of target \"own\" a new session: its next delivery starts a new hidden session (the old one is kept, hidden). For a session that is broken or whose context went wrong.",
    parameters: Type.Object({ id: idParam }),
    returns: AutomationSchema,
    async: true,
    tags: ["automations", "replace", "reset", "new session", "broken", "fix"],
    execute: ({ id }) => automations.replaceSession(id),
  });

  return {
    functions: [create, cancel, list, runs, replaceSession],
    types: [
      { name: "Automation", schema: AutomationSchema },
      { name: "AutomationRun", schema: AutomationRunSchema },
    ],
  };
}
