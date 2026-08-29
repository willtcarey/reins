import { describe, expect, test } from "bun:test";
import {
  parseBenchmarkArgs,
  summarizeSamples,
  summarizeTraceEvents,
} from "../diff-renderer-benchmark-lib.js";

describe("diff renderer benchmark helpers", () => {
  test("parses a reproducible subset of benchmark dimensions", () => {
    const config = parseBenchmarkArgs([
      "--renderers=classic,virtualized",
      "--fixtures=small,large-file",
      "--profiles=desktop-normal,mobile-throttled",
      "--repetitions=3",
      "--idle-ms=1500",
      "--output=tmp/results.json",
      "--no-build",
    ]);

    expect(config.renderers).toEqual(["classic", "virtualized"]);
    expect(config.fixtures).toEqual(["small", "large-file"]);
    expect(config.profiles.map((profile) => profile.id)).toEqual(["desktop-normal", "mobile-throttled"]);
    expect(config.repetitions).toBe(3);
    expect(config.idleMs).toBe(1500);
    expect(config.outputPath).toBe("tmp/results.json");
    expect(config.build).toBe(false);
  });

  test("reports median and observed range without hiding cold and warm samples", () => {
    expect(summarizeSamples([9, 2, 5, 4])).toEqual({
      count: 4,
      median: 4.5,
      min: 2,
      max: 9,
    });
    expect(summarizeSamples([])).toBeNull();
  });

  test("sums main-thread trace durations and counts long tasks and paint work", () => {
    const summary = summarizeTraceEvents([
      { name: "RunTask", ph: "X", dur: 60_000, ts: 0, pid: 1, tid: 2 },
      { name: "FunctionCall", ph: "X", dur: 12_500, ts: 1, pid: 1, tid: 2 },
      { name: "Layout", ph: "X", dur: 3_000, ts: 2, pid: 1, tid: 2 },
      { name: "Paint", ph: "X", dur: 1_250, ts: 3, pid: 1, tid: 2 },
      { name: "TimerFire", ph: "X", dur: 500, ts: 4, pid: 1, tid: 2 },
      { name: "RunTask", ph: "X", dur: 20_000, ts: 5, pid: 1, tid: 9 },
    ], { pid: 1, tid: 2 });

    expect(summary).toEqual({
      mainThreadTaskMs: 60,
      scriptMs: 12.5,
      layoutMs: 3,
      paintMs: 1.25,
      timerMs: 0.5,
      longTaskCount: 1,
      longestTaskMs: 60,
    });
  });
});
