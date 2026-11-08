/**
 * One registered service of an extension (`reins.services.register`, docs/dev/server-sdk.md *Services*): its
 * instances, one at a time, from the host's first `start` to its `stop`, restarted with a backoff after a
 * crash, and its state for the host's report.
 */

import type { Logger, Service, ServiceInstance } from "@reins/sdk/server";

/** How long the host waits for an instance to stop (its start included, if it is still starting). */
export const STOP_TIMEOUT_MS = 5_000;
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** An instance that ran this long before its crash was healthy: the backoff starts again from the first. */
const HEALTHY_MS = 60_000;

/** A service as the host reports it (`ExtensionView.services`). */
export interface ServiceView {
  name: string;
  /** `restarting`: it crashed and waits for `nextAttemptAt`. `stopped`: the host stopped it. `failed`: an
   * instance did not stop in time, so the host starts none again in this app. */
  state: "starting" | "running" | "restarting" | "stopped" | "failed";
  /** When it entered `state`. */
  since: string;
  /** How many times the host started it again after a crash. */
  restarts: number;
  nextAttemptAt: string | null;
  lastError: { message: string; at: string } | null;
}

/** One instance: its start's result, and whether it has ended (crashed or stopped). */
interface Run {
  controller: AbortController;
  instance: Promise<ServiceInstance | void>;
  runningSince: number | null;
  ended: boolean;
}

export class ServiceRunner {
  private state: ServiceView["state"] = "stopped";
  private since = Date.now();
  private restarts = 0;
  /** Crashes since the last healthy instance: the next backoff's exponent. */
  private crashes = 0;
  private nextAttemptAt: number | null = null;
  private lastError: ServiceView["lastError"] = null;
  private run: Run | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** The end of a crashed instance, which a restart or the host's stop waits for. */
  private ending: Promise<boolean> = Promise.resolve(true);
  private stopped: Promise<void> | null = null;

  /** `report`: a crash or a stop that did not end, for the extension's errors. */
  constructor(
    readonly name: string,
    private readonly service: Service,
    private readonly logger: Logger,
    private readonly report: (error: Error) => void,
  ) {}

  /** Starts the first instance; nothing once stopped. */
  start(): void {
    if (this.stopped || this.run) return;
    this.attempt();
  }

  /** Stops it for good: no restart, the instance stopped (bounded by `STOP_TIMEOUT_MS`). Resolves once done or
   * given up; calling it again gives the same promise. */
  stop(): Promise<void> {
    this.stopped ??= (async () => {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      this.nextAttemptAt = null;
      const run = this.run;
      const live = run && !run.ended;
      if (run) run.ended = true;
      if (this.state !== "failed") this.enter("stopped");
      // A crashed instance may still be ending: never two at once, so wait for it first.
      const ended = await this.ending && (!live || await this.end(run));
      if (!ended) this.enter("failed");
    })();
    return this.stopped;
  }

  view(): ServiceView {
    return {
      name: this.name,
      state: this.state,
      since: new Date(this.since).toISOString(),
      restarts: this.restarts,
      nextAttemptAt: this.nextAttemptAt === null ? null : new Date(this.nextAttemptAt).toISOString(),
      lastError: this.lastError,
    };
  }

  private attempt(): void {
    const controller = new AbortController();
    const run: Run = { controller, instance: Promise.resolve(), runningSince: null, ended: false };
    this.run = run;
    this.nextAttemptAt = null;
    this.enter("starting");
    const context = Object.freeze({ signal: controller.signal, logger: this.logger, fail: (error: unknown) => this.crash(run, error) });
    run.instance = (async () => this.service.start(context))();
    run.instance.then(
      () => {
        if (run.ended) return;
        run.runningSince = Date.now();
        this.enter("running");
      },
      (error: unknown) => this.crash(run, error),
    );
  }

  private crash(run: Run, error: unknown): void {
    if (run.ended || this.stopped) return;
    run.ended = true;
    this.setError(error);
    this.report(new Error(`Service ${this.name} crashed: ${messageOf(error)}`, { cause: error }));
    if (run.runningSince !== null && Date.now() - run.runningSince >= HEALTHY_MS) this.crashes = 0;
    this.ending = this.end(run);
    void this.ending.then(ended => {
      if (this.stopped) return;
      if (!ended) {
        this.enter("failed");
        return;
      }
      const delay = Math.min(FIRST_BACKOFF_MS * 2 ** this.crashes, MAX_BACKOFF_MS);
      this.crashes++;
      this.enter("restarting");
      this.nextAttemptAt = Date.now() + delay;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.restarts++;
        this.attempt();
      }, delay);
    });
  }

  /** Aborts the instance and calls its `stop` once its start has settled: false when that took longer than
   * `STOP_TIMEOUT_MS` (reported; the instance may still run). */
  private async end(run: Run): Promise<boolean> {
    run.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS); });
    const stopped = (async () => {
      let instance: ServiceInstance | void;
      try {
        instance = await run.instance;
      } catch {
        return true; // Its start failed: nothing to stop.
      }
      try {
        await instance?.stop?.();
      } catch (error) {
        this.report(new Error(`Service ${this.name}: its stop threw: ${messageOf(error)}`, { cause: error }));
      }
      return true;
    })();
    const ended = await Promise.race([stopped, timedOut]);
    clearTimeout(timer);
    if (!ended) {
      const error = new Error(`Service ${this.name} did not stop within ${STOP_TIMEOUT_MS / 1000} s`);
      this.setError(error);
      this.report(error);
    }
    return ended;
  }

  private enter(state: ServiceView["state"]): void {
    this.state = state;
    this.since = Date.now();
  }

  private setError(error: unknown): void {
    this.lastError = { message: messageOf(error), at: new Date().toISOString() };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
