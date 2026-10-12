/**
 * What the server process owns (ADR-029; `ServerProcess` in `state.ts`): the open sessions (live runtimes
 * with their last activity and the openings in progress, live event seqs, each session's submission chain,
 * the process's pause gate and the idle sweep that empties the map), the credential store's per-provider
 * lock, and the current app with its registration. Apps fill the map with runtimes built by their own code;
 * a runtime reaches an app only through `app()`, so a runtime built by one app calls whichever is current
 * later.
 *
 * Process owner code (`server-process.ts` creates it): apps import only its types, through `state.ts`,
 * and a change to it needs a restart.
 */
import type { Database } from "bun:sqlite";
import type { App, CredentialLocks, OpenSession, OpenSessions, PauseGate as PauseGateShape, ServerProcess } from "./state.js";
import { logger } from "./logger.js";

/** A runtime idle this long and not streaming is closed. */
export const RUNTIME_IDLE_MS = 3 * 60_000;
/** How often the process looks for idle runtimes. */
export const IDLE_SWEEP_INTERVAL_MS = 30_000;
/** How long a runtime's call waits for an app during a reload before it fails (as a node's call waits for
 * a connection). */
export const APP_WAIT_MS = 30_000;
/** The `name` of the error `app()` rejects with past `APP_WAIT_MS` (a name: apps cannot share its class). */
export const NO_APP = "NoApp";

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
export async function suspendSessions(sessions: OpenSessions, { pauseMs = SHUTDOWN_PAUSE_MS }: { pauseMs?: number } = {}): Promise<void> {
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

export interface OpenSessionsOptions {
  /** `RUNTIME_IDLE_MS` by default. */
  idleMs?: number;
  now?: () => number;
}

/** The process's `OpenSessions`, with `retire`, which an app starting calls (`registerApp`): runtimes
 * earlier apps built are closed at once when idle and retired otherwise. */
export function createOpenSessions({ idleMs = RUNTIME_IDLE_MS, now = Date.now }: OpenSessionsOptions = {}): OpenSessions & { retire(): void } {
  const live = new Map<string, OpenSession>();
  const opening = new Map<string, Promise<OpenSession["runtime"]>>();
  const close = (sessionId: string, entry: OpenSession, why: string) => {
    if (live.get(sessionId) === entry) live.delete(sessionId);
    entry.runtime.close().then(
      () => logger.info(`Session runtime closed (${why}): ${sessionId} (remaining: ${live.size})`),
      (error: unknown) => logger.warn(`Closing session runtime ${sessionId} failed:`, error instanceof Error ? error.message : error),
    );
  };
  return {
    live, opening, eventSeqs: new Map(), submissions: new Map(), pauseGate: new PauseGate(),
    retire() {
      // Built by earlier apps: the next open of each session uses the new code.
      for (const [sessionId, entry] of live) {
        if (entry.runtime.isStreaming()) entry.retired = true;
        else close(sessionId, entry, "new app");
      }
    },
    sweep() {
      const at = now();
      for (const [sessionId, entry] of live) {
        if (opening.has(sessionId) || entry.runtime.isStreaming()) continue;
        if (entry.retired) close(sessionId, entry, "new app");
        else if (at - entry.lastActivity >= idleMs) close(sessionId, entry, "idle");
      }
    },
  };
}

/** The credential store's per-provider lock: one for the process. */
export function createCredentialLocks(): CredentialLocks {
  const pending = new Map<string, Promise<void>>();
  return {
    async run(providerId, work) {
      const previous = pending.get(providerId) ?? Promise.resolve();
      const current = Promise.withResolvers<void>();
      pending.set(providerId, current.promise);
      await previous;
      try { return await work(); }
      finally {
        current.resolve();
        if (pending.get(providerId) === current.promise) pending.delete(providerId);
      }
    },
  };
}

export interface ServerProcessOptions extends OpenSessionsOptions {
  /** `APP_WAIT_MS` by default. */
  appWaitMs?: number;
}

/** What the process owner provides of its `ServerProcess`: the database connection, browser broadcast,
 * frontend directory and node socket. */
export interface ProcessResources {
  readonly db: Database;
  broadcast(frame: string): void;
  readonly frontendDir: string;
  readonly nodeSocket: string;
}

/** The process's `ServerProcess`: `resources`, extended in place with the process's open sessions,
 * credential locks and app registration. */
export function createServerProcess(
  resources: ProcessResources,
  { appWaitMs = APP_WAIT_MS, ...sessionOptions }: ServerProcessOptions = {},
): ServerProcess {
  const now = sessionOptions.now ?? Date.now;
  const sessions = createOpenSessions(sessionOptions);
  let current: App | undefined;
  /** Resolved (and replaced) whenever an app registers. */
  let registered = Promise.withResolvers<void>();
  return Object.assign(resources, {
    sessions, credentials: createCredentialLocks(),
    async app(signal: AbortSignal | undefined): Promise<App> {
      const deadline = now() + appWaitMs;
      for (;;) {
        if (current) return current;
        signal?.throwIfAborted();
        const remaining = deadline - now();
        if (remaining <= 0) throw Object.assign(new Error("No app is running (a reload did not finish)"), { name: NO_APP });
        const next = registered.promise;
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
    registerApp(app: App): () => void {
      current = app;
      registered.resolve();
      registered = Promise.withResolvers<void>();
      sessions.retire();
      return () => { if (current === app) current = undefined; };
    },
  });
}
