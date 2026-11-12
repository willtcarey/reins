/**
 * Where an HTTP request's time went, for the slow-request log line (docs/dev/logging.md *Request timing*):
 * the request's timed phases (each git command, parsing) added up by name, and how long the event loop was
 * blocked while it ran. A request whose total is far above its phases waited on the server; one whose lag is
 * high waited on other work in the server process.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface Phase { count: number; ms: number }

export interface RequestTiming {
  /** By name, in the order they first ran. */
  phases: Map<string, Phase>;
  /** The longest the event loop was blocked while the request ran. */
  maxLagMs: number;
}

/**
 * The current request's timing. Shared through a global because process-owned code (`database.ts`, which times
 * SQLite) has its own copy of this module, apart from the app's (docs/dev/hot-reload.md *Ownership*); both
 * must see the same request.
 */
const STORE = Symbol.for("reins.request-timing");
const current: AsyncLocalStorage<RequestTiming> = Reflect.get(globalThis, STORE) ?? new AsyncLocalStorage<RequestTiming>();
Reflect.set(globalThis, STORE, current);

// Bun's own clock: `performance.now` is left to the request's total (tests replace it).
const now = () => Bun.nanoseconds() / 1e6;

/** Runs `fn` as one request, and gives its result with where its time went. */
export async function timeRequest<T>(fn: () => T | Promise<T>): Promise<[T, RequestTiming]> {
  const timing: RequestTiming = { phases: new Map(), maxLagMs: 0 };
  lag.watch(timing);
  try {
    return [await current.run(timing, fn), timing];
  } finally {
    lag.unwatch(timing);
  }
}

/** Runs `fn` as the phase `name` of the request it is part of, if any. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timing = current.getStore();
  if (!timing) return await fn();
  const startedAt = now();
  try {
    return await fn();
  } finally {
    addPhase(timing, name, now() - startedAt);
  }
}

/** `timed` for work that does not wait (parsing). */
export function timedSync<T>(name: string, fn: () => T): T {
  const timing = current.getStore();
  if (!timing) return fn();
  const startedAt = now();
  try {
    return fn();
  } finally {
    addPhase(timing, name, now() - startedAt);
  }
}

function addPhase(timing: RequestTiming, name: string, ms: number): void {
  const phase = timing.phases.get(name) ?? { count: 0, ms: 0 };
  timing.phases.set(name, { count: phase.count + 1, ms: phase.ms + ms });
}

/** `(git diff 640ms, git rev-parse ×2 60ms; event loop lag 13ms)`: the phases, the slowest first. */
export function describeTiming({ phases, maxLagMs }: RequestTiming): string {
  const parts = [...phases]
    .toSorted(([, a], [, b]) => b.ms - a.ms)
    .map(([name, { count, ms }]) => `${name} ${count > 1 ? `×${count} ` : ""}${Math.round(ms)}ms`);
  const lagPart = `event loop lag ${Math.round(maxLagMs)}ms`;
  return parts.length > 0 ? `(${parts.join(", ")}; ${lagPart})` : `(${lagPart})`;
}

/**
 * The event loop's lag, sampled by a timer that runs only while requests are in flight: a tick that comes late
 * was held up by other work. Each request keeps the worst it saw.
 */
const TICK_MS = 20;
const lag = (() => {
  const watching = new Set<RequestTiming>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTick = 0;
  const sample = () => {
    const at = now();
    const late = Math.max(0, at - lastTick - TICK_MS);
    lastTick = at;
    for (const timing of watching) timing.maxLagMs = Math.max(timing.maxLagMs, late);
  };
  return {
    watch(timing: RequestTiming) {
      watching.add(timing);
      if (timer) return;
      lastTick = now();
      timer = setInterval(sample, TICK_MS);
    },
    unwatch(timing: RequestTiming) {
      // A tick still due counts: the request may end right after a blocked stretch.
      timing.maxLagMs = Math.max(timing.maxLagMs, now() - lastTick - TICK_MS);
      watching.delete(timing);
      if (watching.size > 0 || !timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
})();
