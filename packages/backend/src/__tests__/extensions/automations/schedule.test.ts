import { describe, expect, test } from "bun:test";
import { parseSchedule } from "../../../extensions/automations/schedule.js";

const at = (iso: string) => new Date(iso);
const next = (text: string, timezone: string | undefined, after: string) => parseSchedule(text, timezone).next(at(after)).toISOString();

describe("parseSchedule", () => {
  test("an interval is due that long after the time it is asked from", () => {
    expect(next("5m", undefined, "2026-03-28T10:00:00.000Z")).toBe("2026-03-28T10:05:00.000Z");
    expect(next("every 1h30m", undefined, "2026-03-28T10:00:00.000Z")).toBe("2026-03-28T11:30:00.000Z");
    expect(next("2d", undefined, "2026-03-28T10:00:00.000Z")).toBe("2026-03-30T10:00:00.000Z");
  });

  test("a daily time stays at that local time across a change of the timezone's offset", () => {
    // London moves from GMT to BST on 29 March 2026.
    expect(next("daily 09:00", "Europe/London", "2026-03-27T09:00:00.000Z")).toBe("2026-03-28T09:00:00.000Z");
    expect(next("daily 09:00", "Europe/London", "2026-03-28T09:00:00.000Z")).toBe("2026-03-29T08:00:00.000Z");
    expect(next("daily 9:30", "Europe/London", "2026-03-29T08:00:00.000Z")).toBe("2026-03-29T08:30:00.000Z");
  });

  test("weekdays and cron expressions are read in their timezone", () => {
    // Friday 3 April 2026, after 08:30 in New York (EDT, UTC-4): next is Monday.
    expect(next("weekdays 08:30", "America/New_York", "2026-04-03T13:00:00.000Z")).toBe("2026-04-06T12:30:00.000Z");
    expect(next("0 */6 * * *", "Asia/Kolkata", "2026-04-03T00:00:00.000Z")).toBe("2026-04-03T00:30:00.000Z");
  });

  test("keeps its text and timezone, the server's when none is given", () => {
    expect(parseSchedule(" daily 09:00 ", "Europe/London")).toMatchObject({ text: "daily 09:00", timezone: "Europe/London" });
    expect(parseSchedule("5m").timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test("refuses what it cannot read, an interval under a minute and an unknown timezone", () => {
    const refusal = (text: string, timezone?: string) => { try { parseSchedule(text, timezone); return "parsed"; } catch (error) { return error instanceof Error ? error.message : String(error); } };

    expect(refusal("5 minutes")).toStartWith("Not a schedule: 5 minutes.");
    expect(refusal("30s")).toBe("An interval must be at least 1m: 30s");
    expect(refusal("daily 25:00")).toStartWith("Not a schedule: daily 25:00.");
    expect(refusal("0 9 * *")).toStartWith("Not a schedule: 0 9 * *.");
    expect(refusal("0 9 * * *", "Mars/Olympus")).toBe("Not a timezone: Mars/Olympus");
  });
});
