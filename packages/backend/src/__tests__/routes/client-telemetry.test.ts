import { describe, expect, test } from "bun:test";
import { createRouter } from "../../router.js";
import { registerClientTelemetryRoutes } from "../../routes/client-telemetry.js";
import { createServerState } from "../helpers/server-state.js";
import { makeRequest } from "../helpers/request.js";

describe("POST /api/diagnostics/client-events", () => {
  test("accepts a bounded batch of structured diagnostic events", async () => {
    const appended: Array<readonly unknown[]> = [];
    const router = createRouter();
    registerClientTelemetryRoutes(router, {
      append: async (records) => { appended.push(records); },
    });

    const response = await router.handle(makeRequest("POST", "/api/diagnostics/client-events", {
      events: [{
        timestamp: "2026-08-19T15:04:05.123Z",
        runId: "run-1",
        sequence: 1,
        scope: "review-virtualizer",
        event: "navigation-start",
        attributes: { requestedTop: 4200 },
      }],
    }), createServerState());

    expect(response?.status).toBe(202);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.[0]).toMatchObject({
      runId: "run-1",
      sequence: 1,
      event: "navigation-start",
    });
  });

  test("rejects malformed and oversized batches", async () => {
    const router = createRouter();
    registerClientTelemetryRoutes(router, { append: async () => {} });

    const malformed = await router.handle(makeRequest("POST", "/api/diagnostics/client-events", {
      events: [{ event: "missing required fields" }],
    }), createServerState());
    const oversized = await router.handle(makeRequest("POST", "/api/diagnostics/client-events", {
      events: Array.from({ length: 101 }, (_, sequence) => ({
        timestamp: "2026-08-19T15:04:05.123Z",
        runId: "run-1",
        sequence,
        scope: "review-virtualizer",
        event: "scroll",
      })),
    }), createServerState());

    expect(malformed?.status).toBe(400);
    expect(oversized?.status).toBe(413);
  });
});
