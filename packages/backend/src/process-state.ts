/**
 * What the server process owns for sessions across handler loads (ADR-029): the live runtimes with their
 * last activity and the openings in progress, live event seqs, each session's submission chain, the
 * process's pause gate, the load serving now, and the idle sweep that empties the map. Loads fill the map with runtimes built by their own code;
 * a runtime reaches a load only through `server()`, so a runtime built by one load calls whichever serves
 * later. The surfaces between them are typed in `state.ts`.
 *
 * Process owner code (`server-process.ts` creates it): loads import only its types, through `state.ts`,
 * and a change to it needs a restart.
 */
import type { OpenSession, PauseGate as PauseGateShape, ProcessSessions, Server } from "./state.js";
import { logger } from "./logger.js";

/** A runtime idle this long and not streaming is closed. */
export const RUNTIME_IDLE_MS = 3 * 60_000;
/** How often the process looks for idle runtimes. */
export const IDLE_SWEEP_INTERVAL_MS = 30_000;
/** How long a runtime's call waits for a load during a reload before it fails (as a node's call waits for
 * a connection). */
export const SERVER_WAIT_MS = 30_000;
/** The `name` of the error `server` rejects with past `SERVER_WAIT_MS` (a name: loads cannot share its class). */
export const NO_SERVER = "NoServer";

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

/** How long a shutdown waits for every run to reach a pause point before suspending them anyway. */
export const SHUTDOWN_PAUSE_MS = 3_000;
/** Bound on suspending the runtimes at shutdown. */
const SHUTDOWN_SUSPEND_MS = 5_000;

/**
 * Process shutdown (SIGTERM, SIGINT): closes the pause gate, waits up to `pauseMs` for every live runtime
 * to be paused (each run held at a pause point, nothing in flight), then suspends every runtime without
 * aborting its run, which stays pending in storage for the next process to resume (ADR-021, ADR-029).
 * A runtime still busy at the deadline is cut off: its request or tool call in flight is recovered on
 * resume. Resolves once every runtime is suspended (bounded).
 */
export async function suspendSessions(sessions: ProcessSessions, { pauseMs = SHUTDOWN_PAUSE_MS }: { pauseMs?: number } = {}): Promise<void> {
  sessions.pauseGate.close();
  const deadline = Date.now() + pauseMs;
  const unpaused = () => [...sessions.live.values()].filter(entry => !entry.runtime.isPaused()).length + sessions.opening.size;
  while (unpaused() > 0 && Date.now() < deadline) await Bun.sleep(20);
  const remaining = unpaused();
  if (remaining > 0) logger.warn(`Suspending ${remaining} session runtime(s) not paused within ${pauseMs} ms`);
  const entries = [...sessions.live.entries()];
  sessions.live.clear();
  const suspended = Promise.allSettled(entries.map(([sessionId, entry]) => entry.runtime.suspend().catch((error: unknown) => {
    logger.warn(`Suspending session runtime ${sessionId} failed:`, error instanceof Error ? error.message : error);
  })));
  await Promise.race([suspended, Bun.sleep(SHUTDOWN_SUSPEND_MS)]);
  logger.info(`Suspended ${entries.length} session runtime(s)`);
}

export interface ProcessSessionsOptions {
  /** `RUNTIME_IDLE_MS` by default. */
  idleMs?: number;
  /** `SERVER_WAIT_MS` by default. */
  serverWaitMs?: number;
  now?: () => number;
}

/** The process's sessions, with `sweep`, which closes idle runtimes (call it every
 * `IDLE_SWEEP_INTERVAL_MS`). */
export function createProcessSessions({ idleMs = RUNTIME_IDLE_MS, serverWaitMs = SERVER_WAIT_MS, now = Date.now }: ProcessSessionsOptions = {}): ProcessSessions & { sweep(): void } {
  const live = new Map<string, OpenSession>();
  const opening = new Map<string, Promise<OpenSession["runtime"]>>();
  let serving: Server | undefined;
  /** Resolved (and replaced) whenever a load starts serving. */
  let served = Promise.withResolvers<void>();
  const close = (sessionId: string, entry: OpenSession, why: string) => {
    if (live.get(sessionId) === entry) live.delete(sessionId);
    entry.runtime.close().then(
      () => logger.info(`Session runtime closed (${why}): ${sessionId} (remaining: ${live.size})`),
      (error: unknown) => logger.warn(`Closing session runtime ${sessionId} failed:`, error instanceof Error ? error.message : error),
    );
  };
  return {
    live, opening, eventSeqs: new Map(), submissions: new Map(), pauseGate: new PauseGate(),
    async server(signal) {
      const deadline = now() + serverWaitMs;
      for (;;) {
        if (serving) return serving;
        signal?.throwIfAborted();
        const remaining = deadline - now();
        if (remaining <= 0) throw Object.assign(new Error("No server load is serving (a reload did not finish)"), { name: NO_SERVER });
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
    serve(server) {
      serving = server;
      served.resolve();
      served = Promise.withResolvers<void>();
      // Built by earlier loads: the next open of each session uses the new code.
      for (const [sessionId, entry] of live) {
        if (entry.runtime.isStreaming()) entry.retired = true;
        else close(sessionId, entry, "new server load");
      }
      return () => { if (serving === server) serving = undefined; };
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
