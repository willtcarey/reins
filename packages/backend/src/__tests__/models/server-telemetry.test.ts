import { describe, expect, test } from "bun:test";
import { ServerTelemetry } from "../../models/server-telemetry.js";

function harness(enabled: boolean) {
  const records: unknown[] = [];
  const telemetry = new ServerTelemetry({
    enabled,
    sink: { append: async (batch) => { records.push(...batch); } },
    wallNow: () => 1_700_000_000_000,
  });
  return { telemetry, records };
}

describe("ServerTelemetry", () => {
  test("writes records in the browser's envelope under one server run, in sequence", () => {
    const { telemetry, records } = harness(true);
    telemetry.record("session-bus", "window", { events: 3 });
    telemetry.record("session-bus", "window");

    const runId = expect.stringMatching(/^server-/);
    expect(records).toEqual([
      { timestamp: "2023-11-14T22:13:20.000Z", runId, sequence: 1, scope: "session-bus", event: "window", attributes: { events: 3 } },
      { timestamp: "2023-11-14T22:13:20.000Z", runId, sequence: 2, scope: "session-bus", event: "window" },
    ]);
  });

  test("records nothing when disabled", () => {
    const { telemetry, records } = harness(false);
    telemetry.record("session-bus", "window", { events: 3 });
    expect(records).toEqual([]);
  });
});
