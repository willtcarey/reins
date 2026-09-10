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

  test("drops events whose attributes or timestamp throw without losing queued events", async () => {
    const events: ClientTelemetryEvent[] = [];
    let clockFails = false;
    const telemetry = new ClientTelemetry({
      enabled: () => true,
      autoFlush: false,
      maxQueue: 1,
      now: () => {
        if (clockFails) throw new Error("clock unavailable");
        return "2026-08-19T15:04:05.123Z";
      },
      transport: async (batch) => { events.push(...batch); },
    });
    telemetry.record("review", "retained");
    expect(() => telemetry.record("review", "bad-attributes", () => {
      throw new Error("attribute failure");
    })).not.toThrow();
    expect(() => telemetry.startOperation("review").record("bad-operation", () => {
      throw new Error("operation attribute failure");
    })).not.toThrow();
    clockFails = true;
    expect(() => telemetry.record("review", "bad-timestamp")).not.toThrow();
    await telemetry.flush();
    expect(events.map((event) => event.event)).toEqual(["retained"]);
    clockFails = false;
    telemetry.record("review", "recovered");
    await telemetry.flush();
    expect(events.map((event) => event.event)).toEqual(["retained", "recovered"]);
  });

  test("treats broken enablement as disabled and can resume exporting", async () => {
    const events: ClientTelemetryEvent[] = [];
    let enablementFails = false;
    const telemetry = new ClientTelemetry({
      enabled: () => {
        if (enablementFails) throw new Error("enablement unavailable");
        return true;
      },
      autoFlush: false,
      transport: async (batch) => { events.push(...batch); },
    });
    telemetry.record("review", "retained");
    enablementFails = true;
    expect(() => telemetry.record("review", "discarded")).not.toThrow();
    expect(telemetry.enabled).toBe(false);
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(events).toEqual([]);
    enablementFails = false;
    await telemetry.flush();
    expect(events.map((event) => event.event)).toEqual(["retained"]);
  });

  test("contains transport failures and retains only the bounded queue for a later flush", async () => {
    const events: ClientTelemetryEvent[] = [];
    let transportFails = true;
    const telemetry = new ClientTelemetry({
      enabled: () => true,
      autoFlush: false,
      maxQueue: 2,
      transport: async (batch) => {
        if (transportFails) throw new Error("offline");
        events.push(...batch);
      },
    });
    telemetry.record("review", "one");
    telemetry.record("review", "two");
    await expect(telemetry.flush()).resolves.toBeUndefined();
    telemetry.record("review", "three");
    transportFails = false;
    await telemetry.flush();
    expect(events.map((event) => event.event)).toEqual(["two", "three"]);
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
