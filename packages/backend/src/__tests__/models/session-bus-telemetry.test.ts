import { describe, expect, test } from "bun:test";
import { SessionBusTelemetry } from "../../models/session-bus-telemetry.js";

function harness(enabled = true) {
  const records: { scope: string; event: string; attributes: unknown }[] = [];
  const timers: (() => void)[] = [];
  let now = 0;
  let wall = 1_700_000_000_000;
  const telemetry = new SessionBusTelemetry({
    recorder: {
      enabled,
      record: (scope, event, attributes) => { records.push({ scope, event, attributes }); },
    },
    now: () => now,
    wallNow: () => wall,
    setTimer: (callback) => { timers.push(callback); },
  });
  return { telemetry, records, timers, advance: (ms: number) => { now += ms; wall += ms; } };
}

describe("SessionBusTelemetry", () => {
  test("separates emission bursts from arrival bursts and reports transit and relay time in one window", () => {
    const { telemetry, records, timers, advance } = harness();
    const emitted = 1_700_000_000_000;
    // The node emits three events 20ms apart; they arrive together 60ms after the first was emitted.
    advance(60);
    telemetry.relayed({ sessionId: "s", missed: 0, emittedAt: emitted, bytes: 10, receivedAt: 60, clients: 2 });
    advance(1);
    telemetry.relayed({ sessionId: "s", missed: 0, emittedAt: emitted + 20, bytes: 20, receivedAt: 61, clients: 2 });
    advance(1);
    telemetry.relayed({ sessionId: "s", missed: 2, emittedAt: emitted + 40, bytes: 30, receivedAt: 62, clients: 2 });

    expect(records).toEqual([]);
    timers[0]!();

    expect(records).toEqual([{
      scope: "session-bus",
      event: "window",
      attributes: {
        windowMs: 2,
        sessions: 1,
        events: 3,
        bytes: 60,
        missed: 2,
        clientsMax: 2,
        emitGapCount: 2,
        emitGapMeanMs: 20,
        emitGapMaxMs: 20,
        arrivalGapCount: 2,
        arrivalGapMeanMs: 1,
        arrivalGapMaxMs: 1,
        emitBurstMax: 1,
        arrivalBurstMax: 3,
        transitCount: 3,
        transitMeanMs: 41,
        transitMaxMs: 60,
        transitSlowCount: 1,
        relayCount: 3,
        relayMeanMs: 0,
        relayMaxMs: 0,
      },
    }]);
  });

  test("records nothing and schedules nothing when disabled", () => {
    const { telemetry, records, timers } = harness(false);
    telemetry.relayed({ sessionId: "s", missed: 0, emittedAt: 0, bytes: 1, receivedAt: 0, clients: 1 });
    telemetry.flushWindow();
    expect({ records, timers }).toEqual({ records: [], timers: [] });
  });
});
