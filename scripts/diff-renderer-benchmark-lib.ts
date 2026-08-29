export const BENCHMARK_RENDERERS = ["classic", "codeview", "virtualized"] as const;
export const BENCHMARK_FIXTURES = ["small", "many-files", "large-file"] as const;

export type BenchmarkRenderer = typeof BENCHMARK_RENDERERS[number];
export type BenchmarkFixture = typeof BENCHMARK_FIXTURES[number];

export interface BenchmarkProfile {
  id: string;
  viewport: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  cpuThrottlingRate: number;
}

export const BENCHMARK_PROFILES: readonly BenchmarkProfile[] = [
  {
    id: "desktop-normal",
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    cpuThrottlingRate: 1,
  },
  {
    id: "desktop-throttled",
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    cpuThrottlingRate: 4,
  },
  {
    id: "mobile-normal",
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    cpuThrottlingRate: 1,
  },
  {
    id: "mobile-throttled",
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    cpuThrottlingRate: 4,
  },
];

export interface BenchmarkConfig {
  renderers: BenchmarkRenderer[];
  fixtures: BenchmarkFixture[];
  profiles: BenchmarkProfile[];
  repetitions: number;
  idleMs: number;
  outputPath: string;
  build: boolean;
}

export function parseBenchmarkArgs(args: string[]): BenchmarkConfig {
  const values = new Map<string, string>();
  let build = true;
  for (const arg of args) {
    if (arg === "--no-build") {
      build = false;
      continue;
    }
    if (!arg.startsWith("--") || !arg.includes("=")) throw new Error(`Unknown benchmark argument: ${arg}`);
    const [key, ...rest] = arg.slice(2).split("=");
    values.set(key, rest.join("="));
  }

  const renderers = parseSelection(values.get("renderers"), BENCHMARK_RENDERERS, "renderer");
  const fixtures = parseSelection(values.get("fixtures"), BENCHMARK_FIXTURES, "fixture");
  const profileIds = parseSelection(
    values.get("profiles"),
    BENCHMARK_PROFILES.map((profile) => profile.id),
    "profile",
  );
  const repetitions = parsePositiveInteger(values.get("repetitions") ?? "5", "repetitions");
  const idleMs = parsePositiveInteger(values.get("idle-ms") ?? "3000", "idle-ms");

  return {
    renderers,
    fixtures,
    profiles: profileIds.map((id) => BENCHMARK_PROFILES.find((profile) => profile.id === id)!),
    repetitions,
    idleMs,
    outputPath: values.get("output") ?? "docs/benchmarks/diff-renderers-results.json",
    build,
  };
}

function parseSelection<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T[] {
  if (!value) return [...allowed];
  const selected: T[] = [];
  for (const item of value.split(",").filter(Boolean)) {
    const match = allowed.find((candidate) => candidate === item);
    if (!match) throw new Error(`Unknown ${label}: ${item}`);
    selected.push(match);
  }
  if (selected.length === 0) throw new Error(`At least one ${label} is required`);
  return selected;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export interface SampleSummary {
  count: number;
  median: number;
  min: number;
  max: number;
}

export function summarizeSamples(samples: readonly number[]): SampleSummary | null {
  if (samples.length === 0) return null;
  const sorted = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return { count: sorted.length, median, min: sorted[0], max: sorted.at(-1)! };
}

export interface TraceEvent {
  name: string;
  ph: string;
  dur?: number;
  ts: number;
  pid: number;
  tid: number;
  args?: { name?: string };
}

export interface MainThreadIdentity {
  pid: number;
  tid: number;
}

export function summarizeTraceEvents(events: readonly TraceEvent[], mainThread: MainThreadIdentity) {
  const matching = events.filter((event) => (
    event.ph === "X"
      && event.pid === mainThread.pid
      && event.tid === mainThread.tid
      && typeof event.dur === "number"
  ));
  const duration = (names: readonly string[]) => matching
    .filter((event) => names.includes(event.name))
    .reduce((total, event) => total + event.dur!, 0) / 1000;
  const taskNames = ["RunTask", "ThreadControllerImpl::RunTask"];
  const tasks = matching.filter((event) => taskNames.includes(event.name));
  const taskDurations = tasks.map((event) => event.dur! / 1000);

  return {
    mainThreadTaskMs: duration(taskNames),
    scriptMs: duration(["EvaluateScript", "FunctionCall", "EventDispatch", "RunMicrotasks"]),
    layoutMs: duration(["Layout", "UpdateLayoutTree"]),
    paintMs: duration(["Paint", "PrePaint", "RasterTask"]),
    timerMs: duration(["TimerFire", "FireAnimationFrame", "RequestAnimationFrame"]),
    longTaskCount: taskDurations.filter((value) => value >= 50).length,
    longestTaskMs: taskDurations.length > 0 ? Math.max(...taskDurations) : 0,
  };
}
