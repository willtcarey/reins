import { describe, expect, test } from "bun:test";
import { ClientTelemetry, type ClientTelemetryEvent } from "../../models/client-telemetry.js";

describe("ClientTelemetry", () => {
  test("bounds its queue and exports structured events in bounded batches", async () => {
    const batches: ClientTelemetryEvent[][] = [];
    const telemetry = new ClientTelemetry({
      enabled: () => true,
      maxQueue: 3,
      maxBatch: 2,
      autoFlush: false,
      runId: "run-1",
      now: () => "2026-08-19T15:04:05.123Z",
      transport: async (events) => { batches.push([...events]); },
    });

    telemetry.record("review-virtualizer", "one");
    telemetry.record("review-virtualizer", "two");
    telemetry.record("review-virtualizer", "three");
    telemetry.record("review-virtualizer", "four");
    await telemetry.flush();

    expect(batches.map((batch) => batch.map((event) => event.event))).toEqual([
      ["two", "three"],
      ["four"],
    ]);
    expect(batches.flat()[0]).toMatchObject({
      timestamp: "2026-08-19T15:04:05.123Z",
      runId: "run-1",
      sequence: 2,
      scope: "review-virtualizer",
    });
  });

  test("correlates each operation independently within one page lifetime", async () => {
    const events: ClientTelemetryEvent[] = [];
    const telemetry = new ClientTelemetry({
      enabled: () => true,
      autoFlush: false,
      runId: "page-1",
      transport: async (batch) => { events.push(...batch); },
    });

    const firstNavigation = telemetry.startOperation("review-navigation");
    firstNavigation.record("navigation-start", { targetIndex: 4 });
    firstNavigation.record("scroll", { actualTop: 100 });
    const secondNavigation = telemetry.startOperation("review-navigation");
    secondNavigation.record("navigation-start", { targetIndex: 8 });
    await telemetry.flush();

    expect(events.map((event) => event.attributes?.operationId)).toEqual([
      "review-navigation-1",
      "review-navigation-1",
      "review-navigation-2",
    ]);
  });

  test("does not collect events while disabled", async () => {
    let exports = 0;
    const telemetry = new ClientTelemetry({
      enabled: () => false,
      autoFlush: false,
      transport: async () => { exports += 1; },
    });

    telemetry.record("review-virtualizer", "scroll", { scrollTop: 100 });
    await telemetry.flush();

    expect(exports).toBe(0);
  });
});
