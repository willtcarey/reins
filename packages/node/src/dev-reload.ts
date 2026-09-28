/**
 * Dev reload for the node process (`bun run dev` only; see docs/dev/hot-reload.md). The supervisor sets
 * `REINS_NODE_DEV_RELOAD=1`; `main.ts` then watches the node sources and, after a change, waits until the
 * node is idle (no active run, no command or session work in progress), shuts down cleanly and exits with
 * `NODE_RELOAD_EXIT_CODE`, which the supervisor answers with an immediate restart. A run is never
 * interrupted for a reload; commands the server submits meanwhile wait in its outbox and are delivered
 * after the new process reconnects.
 */
import { watch } from "node:fs";

/** "Restart me to load new code" (EX_TEMPFAIL); the supervisor restarts on it without crash backoff.
 * `packages/backend/src/supervisor.ts` keeps its own copy (it imports nothing from the node). */
export const NODE_RELOAD_EXIT_CODE = 75;

/** Whether a change to `filename` (relative to the watched source directory) is node code. */
export function isReloadSource(filename: string): boolean {
  return filename.endsWith(".ts") && !filename.endsWith(".test.ts") && !/(^|\/)(__\w+__|dist|node_modules)\//.test(filename);
}

/** Calls `onChange` with each changed node source under `dir`; returns a function that stops watching. */
export function watchSources(dir: string, onChange: (filename: string) => void): () => void {
  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (filename && isReloadSource(filename)) onChange(filename);
  });
  return () => watcher.close();
}

/** `target` with each method call (except `untracked`) counted from call until its promise settles. For
 * the node: every command from receipt to reply (attachment downloads before admission included), so a
 * reload never cuts one off. */
export function trackCalls<T extends object>(target: T, untracked: ReadonlyArray<keyof T>): { tracked: T; inFlight(): number } {
  let inFlight = 0;
  const tracked = new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== "function" || untracked.some(name => name === key)) return value;
      return async (...args: unknown[]) => {
        inFlight++;
        try { return await value.apply(object, args); }
        finally { inFlight--; }
      };
    },
  });
  return { tracked, inFlight: () => inFlight };
}

export interface ReloadActivity {
  activeRuns: number;
  /** Commands, runtime openings and session work in progress. */
  pending: number;
}

export interface ReloadWhenIdleOptions {
  activity(): ReloadActivity;
  /** Called once, when the node is idle after a change. */
  reload(): void;
  log(message: string): void;
  /** Changes within this window are one reload. */
  debounceMs?: number;
  /** How often a waiting reload checks for idle. */
  pollMs?: number;
}

export interface ReloadWhenIdle {
  /** A node source changed (or a reload was requested). */
  changed(what: string): void;
  /** Cancels a pending reload (the node is stopping anyway). */
  stop(): void;
}

export function createReloadWhenIdle({ activity, reload, log, debounceMs = 200, pollMs = 250 }: ReloadWhenIdleOptions): ReloadWhenIdle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changes: string[] = [];
  let waitingFor: string | undefined;
  let done = false;
  const check = () => {
    timer = undefined;
    if (done) return;
    const { activeRuns, pending } = activity();
    if (activeRuns === 0 && pending === 0) {
      done = true;
      log(`node reloading after code change (${changes.join(", ")})`);
      reload();
      return;
    }
    const waiting = activeRuns > 0 ? `${activeRuns} active run${activeRuns === 1 ? "" : "s"}` : "work in progress";
    if (waiting !== waitingFor) log(`code changed (${changes.join(", ")}); waiting for ${waiting} before reloading`);
    waitingFor = waiting;
    timer = setTimeout(check, pollMs);
  };
  return {
    changed(what) {
      if (done) return;
      if (!changes.includes(what)) changes = [...changes, what];
      // Restart the debounce window, unless already waiting for idle (the poll picks the change up).
      if (waitingFor !== undefined) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(check, debounceMs);
    },
    stop() {
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
