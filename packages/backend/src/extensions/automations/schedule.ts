/**
 * When an automation is due: an interval (`5m`, `every 1h30m`), a local time (`daily 09:00`, `weekdays
 * 08:30`) or a five-field cron expression, in an IANA timezone. Cron and local times are croner's, which
 * keeps a local time across a change of the timezone's offset.
 */

import { Cron } from "croner";

export interface Schedule {
  /** As it was given, trimmed: what is stored and shown. */
  readonly text: string;
  readonly timezone: string;
  /** The first time it is due after `after`. */
  next(after: Date): Date;
}

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const INTERVAL = /^(?:every\s+)?((?:\d+[smhd])+)$/i;
const LOCAL_TIME = /^(daily|weekdays)\s+([01]?\d|2[0-3]):([0-5]\d)$/i;
// The service looks every 30 s, so a shorter interval could not be kept.
const MIN_INTERVAL_MS = 60_000;
const FORMS = "Give an interval (\"5m\", \"every 1h30m\"), \"daily HH:MM\", \"weekdays HH:MM\" or a five-field cron expression (\"0 9 * * 1-5\").";

export const serverTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function checkTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new InvalidScheduleError(`Not a timezone: ${timezone}`);
  }
}

function cronOf(text: string): string | null {
  const local = LOCAL_TIME.exec(text);
  if (local) return `${Number(local[3])} ${Number(local[2])} * * ${local[1]!.toLowerCase() === "daily" ? "*" : "1-5"}`;
  return text.split(/\s+/).length === 5 ? text : null;
}

/** Reads `text` in `timezone` (the server's by default); throws `InvalidScheduleError`. */
export function parseSchedule(text: string, timezone: string = serverTimezone()): Schedule {
  const trimmed = text.trim();
  checkTimezone(timezone);
  const interval = INTERVAL.exec(trimmed);
  if (interval) {
    let ms = 0;
    for (const [, count, unit] of interval[1]!.matchAll(/(\d+)([smhd])/gi)) ms += Number(count) * UNIT_MS[unit!.toLowerCase()]!;
    if (ms < MIN_INTERVAL_MS) throw new InvalidScheduleError(`An interval must be at least 1m: ${trimmed}`);
    return { text: trimmed, timezone, next: after => new Date(after.getTime() + ms) };
  }
  const pattern = cronOf(trimmed);
  let cron: Cron | undefined;
  try {
    if (pattern) cron = new Cron(pattern, { timezone, paused: true });
  } catch {
    cron = undefined;
  }
  if (!cron) throw new InvalidScheduleError(`Not a schedule: ${trimmed}. ${FORMS}`);
  const schedule = cron;
  return {
    text: trimmed,
    timezone,
    next: after => {
      const due = schedule.nextRun(after);
      if (!due) throw new InvalidScheduleError(`${trimmed} is never due again`);
      return due;
    },
  };
}
