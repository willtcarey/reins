export type DiffBenchmarkRenderer = "classic" | "codeview" | "virtualized";
export type DiffBenchmarkPhase = "payload-decode" | "parse" | "render";

function enabled(): boolean {
  return typeof REINS_DEV !== "undefined" && REINS_DEV && typeof performance !== "undefined";
}

export function diffBenchmarkEntryName(
  renderer: DiffBenchmarkRenderer,
  phase: DiffBenchmarkPhase,
  version: number,
): string {
  return `reins-diff:${renderer}:${phase}:v${version}`;
}

export function measureDiffBenchmark<T>(
  renderer: DiffBenchmarkRenderer,
  phase: DiffBenchmarkPhase,
  version: number,
  action: () => T,
): T {
  if (!enabled()) return action();

  const name = diffBenchmarkEntryName(renderer, phase, version);
  const start = `${name}:start`;
  performance.mark(start);
  try {
    return action();
  } finally {
    performance.measure(name, start);
    performance.clearMarks(start);
  }
}

export function beginDiffBenchmark(
  renderer: DiffBenchmarkRenderer,
  phase: DiffBenchmarkPhase,
  version: number,
): void {
  if (!enabled()) return;
  performance.mark(`${diffBenchmarkEntryName(renderer, phase, version)}:start`);
}

export function endDiffBenchmark(
  renderer: DiffBenchmarkRenderer,
  phase: DiffBenchmarkPhase,
  version: number,
): void {
  if (!enabled()) return;
  const name = diffBenchmarkEntryName(renderer, phase, version);
  const start = `${name}:start`;
  if (!performance.getEntriesByName(start, "mark").length) return;
  performance.measure(name, start);
  performance.clearMarks(start);
}
