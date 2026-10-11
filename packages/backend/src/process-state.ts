/**
 * What the server process owns for sessions across handler loads (ADR-029): the live runtimes with their
 * last activity and the openings in progress, live event seqs, the process's pause gate, the load serving
 * now, and the idle sweep that empties the map. Loads fill the map with runtimes built by their own code;
 * a runtime reaches a load only through `load()`, so a runtime built by one load calls whichever serves
 * later. The surfaces between them are typed in `state.ts`.
 *
 * Process owner code (`server-process.ts` creates it): loads import only its types, through `state.ts`,
 * and a change to it needs a restart.
 */
import type { LiveRuntimeEntry, LoadServices, PauseGate as PauseGateShape, ProcessSessions } from "./state.js";
import { logger } from "./logger.js";

/** A runtime idle this long and not streaming is closed. */
export const RUNTIME_IDLE_MS = 3 * 60_000;
/** How often the process looks for idle runtimes. */
export const IDLE_SWEEP_INTERVAL_MS = 30_000;
/** How long a runtime's call waits for a load during a reload before it fails (as a node's call waits for
 * a connection). */
export const LOAD_WAIT_MS = 30_000;
/** The `name` of the error `load` rejects with past `LOAD_WAIT_MS` (a name: loads cannot share its class). */
export const NO_LOAD_SERVING = "NoLoadServing";

/** Holds runs at their pause points while closed (ADR-021): the process's one gate, which every runtime
 * shares (a SIGTERM pauses every run). */
export class PauseGate implements PauseGateShape {
  private opened: PromiseWithResolvers<void> | undefined;

  get closed(): boolean { return this.opened !== undefined; }

  close(): void { this.opened ??= Promise.withResolvers(); }

  open(): void {
    this.opened?.resolve();
    this.opened = undefined;
  }

  /** Resolves once the gate is open or `signal` aborts (an abort, or the runtime closing). Never rejects:
   * Pi catches a throwing hook, and a throwing `before_tool` blocks its tool. */
  async pass(signal: AbortSignal | undefined): Promise<void> {
    const opened = this.opened;
    if (!opened || signal?.aborted) return;
    const aborted = Promise.withResolvers<void>();
    const onAbort = () => aborted.resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
    try { await Promise.race([opened.promise, aborted.promise]); }
    finally { signal?.removeEventListener("abort", onAbort); }
  }
}

export interface ProcessSessionsOptions {
  /** `RUNTIME_IDLE_MS` by default. */
  idleMs?: number;
  /** `LOAD_WAIT_MS` by default. */
  loadWaitMs?: number;
  now?: () => number;
}

/** The process's sessions, with `sweep`, which closes idle runtimes (call it every
 * `IDLE_SWEEP_INTERVAL_MS`). */
export function createProcessSessions({ idleMs = RUNTIME_IDLE_MS, loadWaitMs = LOAD_WAIT_MS, now = Date.now }: ProcessSessionsOptions = {}): ProcessSessions & { sweep(): void } {
  const live = new Map<string, LiveRuntimeEntry>();
  const opening = new Map<string, Promise<LiveRuntimeEntry["runtime"]>>();
  let serving: LoadServices | undefined;
  /** Resolved (and replaced) whenever a load starts serving. */
  let served = Promise.withResolvers<void>();
  const close = (sessionId: string, entry: LiveRuntimeEntry, why: string) => {
    if (live.get(sessionId) === entry) live.delete(sessionId);
    entry.runtime.close().then(
      () => logger.info(`Session runtime closed (${why}): ${sessionId} (remaining: ${live.size})`),
      (error: unknown) => logger.warn(`Closing session runtime ${sessionId} failed:`, error instanceof Error ? error.message : error),
    );
  };
  return {
    live, opening, eventSeqs: new Map(), pauseGate: new PauseGate(),
    async load(signal) {
      const deadline = now() + loadWaitMs;
      for (;;) {
        if (serving) return serving;
        signal?.throwIfAborted();
        const remaining = deadline - now();
        if (remaining <= 0) throw Object.assign(new Error("No server load is serving (a reload did not finish)"), { name: NO_LOAD_SERVING });
        const next = served.promise;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopped = Promise.withResolvers<void>();
        const onAbort = () => stopped.resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await Promise.race([next, stopped.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); })]);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      }
    },
    serve(services) {
      serving = services;
      served.resolve();
      served = Promise.withResolvers<void>();
      // Built by earlier loads: the next open of each session uses the new code.
      for (const [sessionId, entry] of live) {
        if (entry.runtime.isStreaming()) entry.retired = true;
        else close(sessionId, entry, "new server load");
      }
      return () => { if (serving === services) serving = undefined; };
    },
    sweep() {
      const at = now();
      for (const [sessionId, entry] of live) {
        if (opening.has(sessionId) || entry.runtime.isStreaming()) continue;
        if (entry.retired) close(sessionId, entry, "new server load");
        else if (at - entry.lastActivity >= idleMs) close(sessionId, entry, "idle");
      }
    },
  };
}
