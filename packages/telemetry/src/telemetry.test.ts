import { describe, expect, test } from "bun:test";
import { Cadence, TelemetryWindow } from "./telemetry.js";

describe("TelemetryWindow", () => {
  test("the first measurement opens a window that is exported once, with its duration, when it elapses", () => {
    const exported: Array<{ events: number; durationMs: number }> = [];
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    let now = 100;
    const windows = new TelemetryWindow({
      now: () => now,
      open: () => ({ events: 0 }),
      close: (window, durationMs) => { exported.push({ events: window.events, durationMs }); },
      setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); },
    });

    expect(windows.current).toBeNull();
    windows.active().events += 1;
    now += 30;
    windows.active().events += 1;
    windows.flush();
    timers[0]!.callback(); // the flushed window's timer does not export the next one

    expect({ exported, delays: timers.map(timer => timer.delayMs), current: windows.current }).toEqual({
      exported: [{ events: 2, durationMs: 30 }],
      delays: [1000],
      current: null,
    });
  });
});

describe("Cadence", () => {
  test("reports gaps between events and the length of the current burst", () => {
    const cadence = new Cadence();
    const gaps = [0, 2, 6, 40, 42].map(at => cadence.advance(at));
    expect({ gaps, run: cadence.run }).toEqual({ gaps: [null, 2, 4, 34, 2], run: 2 });
  });
});
