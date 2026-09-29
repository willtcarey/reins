/**
 * `@reins/telemetry`: what the browser's and the server's development diagnostics share
 * (docs/dev/client-telemetry.md). High-frequency measurements are aggregated in memory into windows,
 * each exported as one record. No dependencies, so the frontend bundle and the server both take it.
 */

/** One record in the diagnostics log, from the browser (`POST /api/diagnostics/client-events`) or the server. */
export interface TelemetryEvent {
  timestamp: string;
  /** One page load or server process; `sequence` orders its records. */
  runId: string;
  sequence: number;
  scope: string;
  event: string;
  attributes?: Record<string, unknown>;
}

/** Records one diagnostics event. `enabled` is false outside development, and then nothing is recorded. */
export interface TelemetryRecorder {
  readonly enabled: boolean;
  record(scope: string, event: string, attributes?: Record<string, unknown>): void;
}

/** Count, sum and maximum of a measurement within a window. */
export interface Stat {
  count: number;
  total: number;
  max: number;
}

export function emptyStat(): Stat {
  return { count: 0, total: 0, max: 0 };
}

export function addToStat(stat: Stat, value: number): void {
  stat.count += 1;
  stat.total += value;
  stat.max = Math.max(stat.max, value);
}

/** Rounds to 0.1ms. */
export function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `<prefix>Count`, `<prefix>MeanMs` and `<prefix>MaxMs`. */
export function statAttributes(prefix: string, stat: Stat): Record<string, number> {
  return {
    [`${prefix}Count`]: stat.count,
    [`${prefix}MeanMs`]: stat.count === 0 ? 0 : roundMs(stat.total / stat.count),
    [`${prefix}MaxMs`]: roundMs(stat.max),
  };
}

/** Consecutive events at most this far apart belong to one burst. */
export const BURST_GAP_MS = 4;

/** The spacing of one stream of events: when the last one happened and how long the current burst is. */
export class Cadence {
  last: number | null = null;
  run = 0;

  /** Advances to an event at `at`, returning the gap since the previous event (null for the first). */
  advance(at: number): number | null {
    const gap = this.last === null ? null : at - this.last;
    this.run = gap !== null && gap <= BURST_GAP_MS ? this.run + 1 : 1;
    this.last = at;
    return gap;
  }
}

interface TelemetryWindowOptions<W> {
  now: () => number;
  /** A new, empty window. */
  open: () => W;
  /** Export a finished window that covered `durationMs`. */
  close: (window: W, durationMs: number) => void;
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => void;
}

/**
 * At most one open aggregation window. The first measurement opens it and schedules its export
 * `windowMs` later (1s by default), so nothing runs while nothing is measured.
 */
export class TelemetryWindow<W> {
  private readonly options: TelemetryWindowOptions<W>;
  private open: { window: W; startedAt: number } | null = null;

  constructor(options: TelemetryWindowOptions<W>) {
    this.options = options;
  }

  /** The open window, if any. */
  get current(): W | null {
    return this.open?.window ?? null;
  }

  /** The open window, opening one if none is. */
  active(): W {
    if (this.open) return this.open.window;
    const open = { window: this.options.open(), startedAt: this.options.now() };
    this.open = open;
    const setTimer = this.options.setTimer ?? ((callback, delayMs) => { setTimeout(callback, delayMs); });
    setTimer(() => {
      if (this.open === open) this.flush();
    }, this.options.windowMs ?? 1000);
    return open.window;
  }

  /** Export the open window, if any. Called automatically when a window elapses. */
  flush(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    this.options.close(open.window, this.options.now() - open.startedAt);
  }
}
