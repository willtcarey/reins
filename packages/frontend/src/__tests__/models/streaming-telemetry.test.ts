import { describe, expect, test } from "bun:test";
import { StreamingTelemetry } from "../../models/streaming-telemetry.js";

function harness(enabled = true) {
  const records: { scope: string; event: string; attributes: unknown }[] = [];
  const timers: (() => void)[] = [];
  const paints: (() => void)[] = [];
  let now = 0;
  const telemetry = new StreamingTelemetry({
    recorder: {
      enabled,
      record: (scope, event, attributes) => { records.push({ scope, event, attributes }); },
    },
    now: () => now,
    setTimer: (callback) => { timers.push(callback); },
    afterPaint: (callback) => { paints.push(callback); },
  });
  return { telemetry, records, timers, paints, advance: (ms: number) => { now += ms; } };
}

describe("StreamingTelemetry", () => {
  test("aggregates frames, renders, and parses into one bounded event per window", () => {
    const { telemetry, records, timers, paints, advance } = harness();

    telemetry.frameNotified({ streamIds: new Set(["stream-1"]), events: 3, firstReceivedAt: 0 });
    advance(4);
    telemetry.panelRendered(2);
    telemetry.markdownParsed(1, 500, 40);
    paints.shift()?.();
    advance(10);
    telemetry.frameNotified({ streamIds: new Set(["stream-1"]), events: 1, firstReceivedAt: 12 });
    telemetry.panelRendered(4);
    telemetry.markdownParsed(3, 520, 60);
    advance(4);
    paints.shift()?.();

    expect(records).toEqual([]);
    expect(timers).toHaveLength(1);
    timers[0]!();

    expect(records).toEqual([{
      scope: "streaming",
      event: "window",
      attributes: {
        windowMs: 18,
        streamId: "stream-1",
        streamIds: "stream-1",
        streamCount: 1,
        events: 4,
        frames: 2,
        maxEventsPerFrame: 3,
        receiptToPaintCount: 2,
        receiptToPaintMeanMs: 5,
        receiptToPaintMaxMs: 6,
        panelRenderCount: 2,
        panelRenderMeanMs: 3,
        panelRenderMaxMs: 4,
        markdownParseCount: 2,
        markdownParseMeanMs: 2,
        markdownParseMaxMs: 3,
        markdownTextLengthMax: 520,
        markdownParsedLengthMax: 60,
        socketEvents: 0,
        socketBytes: 0,
        socketGapCount: 0,
        socketGapMeanMs: 0,
        socketGapMaxMs: 0,
        socketBurstMax: 0,
        socketHandleCount: 0,
        socketHandleMeanMs: 0,
        socketHandleMaxMs: 0,
        emitToHandledCount: 0,
        emitToHandledMeanMs: 0,
        emitToHandledMaxMs: 0,
        longTaskCount: 0,
        longTaskMeanMs: 0,
        longTaskMaxMs: 0,
      },
    }]);
  });

  test("reports socket arrival cadence, bursts, handling time, latency and long tasks", () => {
    const { telemetry, records, timers } = harness();

    telemetry.longTask(80); // no window open yet: nothing is streaming
    telemetry.socketEvent({ receivedAt: 0, handledMs: 1, latencyMs: 10, bytes: 100 });
    telemetry.socketEvent({ receivedAt: 2, handledMs: 3, latencyMs: 30, bytes: 100 });
    telemetry.socketEvent({ receivedAt: 4, handledMs: 2, latencyMs: 20, bytes: 100 });
    telemetry.socketEvent({ receivedAt: 50, handledMs: 2, latencyMs: 60, bytes: 100 });
    telemetry.longTask(70);
    timers[0]!();

    expect(records[0]!.attributes).toMatchObject({
      socketEvents: 4,
      socketBytes: 400,
      socketGapCount: 3,
      socketGapMeanMs: 16.7,
      socketGapMaxMs: 46,
      socketBurstMax: 3,
      socketHandleCount: 4,
      socketHandleMeanMs: 2,
      socketHandleMaxMs: 3,
      emitToHandledCount: 4,
      emitToHandledMeanMs: 30,
      emitToHandledMaxMs: 60,
      longTaskCount: 1,
      longTaskMaxMs: 70,
    });
  });

  test("does no work when telemetry is disabled", () => {
    const { telemetry, records, timers, paints } = harness(false);
    telemetry.frameNotified({ streamIds: new Set(["stream-1"]), events: 1, firstReceivedAt: 0 });
    telemetry.socketEvent({ receivedAt: 0, handledMs: 1, latencyMs: 1, bytes: 1 });
    telemetry.panelRendered(1);
    telemetry.markdownParsed(1, 1, 1);
    telemetry.flushWindow();
    expect({ records, timers, paints }).toEqual({ records: [], timers: [], paints: [] });
  });
});
