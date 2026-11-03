/**
 * Wake-ups and heartbeats (docs/features/automations.md): one mechanism, a message sent to a session each
 * time its schedule is due. A wake-up messages the session that asked for it; a heartbeat messages a hidden
 * session of its own, which it starts once and keeps, and records each run's final reply.
 *
 * Everything is in the extension's database, so a reload or a restart loses nothing: `tick` reads what is
 * due each time. A run due while Reins was down is due at the first tick after it, once: the next time is
 * computed from that tick, not from the missed one.
 */

import type { Location, Logger, SessionInfo, SessionSettlement, Sessions } from "@reins/sdk/server";
import { parseSchedule, type Schedule } from "./schedule.js";
import { AutomationStore, type AutomationRow, type AutomationView, type HeartbeatModel, type RunView } from "./store.js";

export class AutomationNotFoundError extends Error {
  constructor(id: number) {
    super(`Automation not found: ${id}`);
    this.name = "AutomationNotFoundError";
  }
}

/** A request the caller got wrong (a blank message, a wake-up given a heartbeat's operation). */
export class InvalidAutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAutomationError";
  }
}

export interface WakeRequest {
  sessionId: string;
  schedule: string;
  timezone?: string;
  message: string;
}

export interface HeartbeatRequest {
  schedule: string;
  timezone?: string;
  prompt: string;
  name?: string;
  source: number | Location;
  model?: HeartbeatModel;
  /** Compact its session after a run that leaves its context above this many tokens. */
  compactAboveTokens?: number;
  createdBySessionId: string | null;
}

/** What the summary keeps, so that the next runs can still tell what is new. */
export const COMPACTION_INSTRUCTIONS = "This session runs the same scheduled prompt again and again. Keep what later runs need to tell what is new: what was already reported, and any state they track.";

const MAX_RUNS = 100;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function required(text: string, what: string): string {
  if (typeof text !== "string" || !text.trim()) throw new InvalidAutomationError(`${what} must not be blank`);
  return text;
}

/** The note a wake-up's message ends with: the session's context may have lost its ID by the time it is done. */
export function wakeNote(row: Pick<AutomationRow, "id" | "schedule">): string {
  return `(Wake-up ${row.id}, ${row.schedule}, from the automations extension. Once it is no longer needed, cancel it: api.automations.cancel(${row.id}).)`;
}

export class Automations {
  private readonly store: AutomationStore;
  /** Ticks, settlements and new heartbeats, one at a time: a settlement then always finds the run its start recorded. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { db: ConstructorParameters<typeof AutomationStore>[0]; sessions: Omit<Sessions, "onSettled">; logger: Logger; now: () => Date }) {
    this.store = new AutomationStore(options.db);
  }

  private get sessions() { return this.options.sessions; }
  private now() { return this.options.now(); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Resolves once the work in progress (a tick, a settlement) ended. */
  idle(): Promise<void> {
    return this.chain.then(() => {});
  }

  private row(id: number): AutomationRow {
    const row = this.store.get(id);
    if (!row) throw new AutomationNotFoundError(id);
    return row;
  }

  private view(row: AutomationRow): AutomationView {
    return this.store.view(row);
  }

  /** A wake-up of `sessionId`: its message is sent to it each time the schedule is due, until it is cancelled. */
  async wake({ sessionId, schedule, timezone, message: text }: WakeRequest): Promise<AutomationView> {
    required(text, "A wake-up's message");
    const parsed = parseSchedule(schedule, timezone);
    await this.sessions.get(sessionId);
    const now = this.now();
    return this.view(this.store.create({
      kind: "wake", name: null, sessionId, createdBySessionId: sessionId, message: text, schedule: parsed.text, timezone: parsed.timezone,
      source: null, model: null, compactAboveTokens: null, nextRunAt: parsed.next(now), createdAt: now,
    }));
  }

  /** A heartbeat: its hidden session is started now with the prompt's first run, then prompted again each time the
   * schedule is due. A session that cannot be started rejects, and nothing is kept. */
  heartbeat(request: HeartbeatRequest): Promise<AutomationView> {
    required(request.prompt, "A heartbeat's prompt");
    if (request.name !== undefined) required(request.name, "A heartbeat's name");
    const parsed = parseSchedule(request.schedule, request.timezone);
    return this.serial(async () => {
      const now = this.now();
      const row = this.store.create({
        kind: "heartbeat", name: request.name?.trim() ?? null, sessionId: null, createdBySessionId: request.createdBySessionId,
        message: request.prompt, schedule: parsed.text, timezone: parsed.timezone, source: request.source, model: request.model ?? null,
        compactAboveTokens: request.compactAboveTokens ?? null, nextRunAt: parsed.next(now), createdAt: now,
      });
      try {
        await this.startSession(row, this.store.addRun({ automationId: row.id, sessionId: null, outcome: "running", startedAt: now }));
      } catch (error) {
        this.store.delete(row.id);
        throw error;
      }
      return this.view(this.row(row.id));
    });
  }

  cancel(id: number, reason: string): AutomationView {
    this.row(id);
    this.store.cancel(id, reason, this.now());
    return this.view(this.row(id));
  }

  list(filter: { sessionId?: string; includeCancelled?: boolean } = {}): AutomationView[] {
    return this.store.list({ ...filter, includeCancelled: filter.includeCancelled === true }).map(row => this.view(row));
  }

  /** Its runs, the latest first. */
  runs(id: number, limit = 20): RunView[] {
    this.row(id);
    return this.store.runs(id, Math.max(1, Math.min(MAX_RUNS, Math.floor(limit))));
  }

  /** Drops a heartbeat's session (it stays, hidden, as it is): its next run starts a new one. */
  replaceSession(id: number): AutomationView {
    const row = this.row(id);
    if (row.kind !== "heartbeat") throw new InvalidAutomationError("Only a heartbeat has a session of its own: a wake-up messages the session that asked for it");
    this.store.setSession(id, null);
    return this.view(this.row(id));
  }

  /** Sends what is due, and cancels the wake-ups whose session was archived or deleted. One automation's failure is
   * logged and does not stop the others. */
  tick(): Promise<void> {
    return this.serial(async () => {
      for (const { id } of this.store.active()) {
        try {
          const row = this.store.get(id);
          if (!row || row.cancelled_at !== null) continue;
          if (row.kind === "wake") await this.checkWake(row);
          else await this.checkHeartbeat(row);
        } catch (error) {
          this.options.logger.warn(`Automation ${id} could not be checked:`, error);
        }
      }
    });
  }

  /** Records how a run of a heartbeat's session ended, and whether its context is now above the heartbeat's threshold. */
  settled(settlement: SessionSettlement): Promise<void> {
    return this.serial(async () => {
      const run = this.store.runningOn(settlement.sessionId);
      if (!run) return;
      this.store.endRun(run.id, {
        outcome: settlement.status, at: this.now(),
        output: settlement.result, error: settlement.error,
      });
      const threshold = this.store.get(run.automation_id)?.compact_above_tokens ?? null;
      if (settlement.status !== "completed" || threshold === null) return;
      const usage = await this.sessions.contextUsage(settlement.sessionId);
      if (usage && usage.usedTokens > threshold) this.store.setCompaction(run.id, "pending");
    });
  }

  /** The session, or null once it is deleted. */
  private async session(sessionId: string): Promise<SessionInfo | null> {
    try {
      return await this.sessions.get(sessionId);
    } catch (error) {
      if (message(error) === `Session not found: ${sessionId}`) return null;
      throw error;
    }
  }

  /** Whether `row` is due now; if it is, its next time is set first, so a failure below does not repeat at each tick. */
  private due(row: AutomationRow, schedule: Schedule, now: Date): boolean {
    if (new Date(row.next_run_at) > now) return false;
    this.store.setNextRun(row.id, schedule.next(now));
    return true;
  }

  private async checkWake(row: AutomationRow): Promise<void> {
    const session = await this.session(row.session_id!);
    const now = this.now();
    if (!session || session.archivedAt !== null) {
      this.store.cancel(row.id, session ? "Its session was archived" : "Its session was deleted", now);
      return;
    }
    if (!this.due(row, parseSchedule(row.schedule, row.timezone), now)) return;
    if (session.running) {
      this.store.addRun({ automationId: row.id, sessionId: session.id, outcome: "skipped", startedAt: now, ended: true });
      return;
    }
    try {
      await this.sessions.send(session.id, `${row.message}\n\n${wakeNote(row)}`);
      this.store.addRun({ automationId: row.id, sessionId: session.id, outcome: "sent", startedAt: now, ended: true });
    } catch (error) {
      this.store.addRun({ automationId: row.id, sessionId: session.id, outcome: "failed", startedAt: now, ended: true, error: message(error) });
    }
  }

  private async checkHeartbeat(row: AutomationRow): Promise<void> {
    let session = row.session_id === null ? null : await this.session(row.session_id);
    if (row.session_id !== null && (!session || session.archivedAt !== null)) {
      this.options.logger.info(`Heartbeat ${row.id}: its session ${row.session_id} is gone; its next run starts a new one`);
      this.store.setSession(row.id, null);
      session = null;
    }
    const compacting = session !== null && !session.running && await this.compactIfPending(row, session.id);
    const now = this.now();
    if (!this.due(row, parseSchedule(row.schedule, row.timezone), now)) return;
    if (session?.running && !compacting) {
      this.store.addRun({ automationId: row.id, sessionId: session.id, outcome: "skipped", startedAt: now, ended: true });
      return;
    }
    const latest = this.store.latestRun(row.id);
    if (latest?.outcome === "running") {
      this.store.endRun(latest.id, { outcome: "lost", at: now, error: "Its end was not heard: Reins reloaded or restarted while it ran" });
    }
    const runId = this.store.addRun({ automationId: row.id, sessionId: session?.id ?? null, outcome: "running", startedAt: now });
    try {
      // Sent behind a compaction that just started, it waits for it and then starts the run.
      if (session) await this.sessions.send(session.id, row.message);
      else await this.startSession(row, runId);
    } catch (error) {
      this.store.endRun(runId, { outcome: "failed", at: this.now(), error: message(error) });
    }
  }

  /** Starts the heartbeat's hidden session with its prompt, as run `runId`. */
  private async startSession(row: AutomationRow, runId: number): Promise<void> {
    const sessionId = await this.sessions.start({
      source: JSON.parse(row.source_json!),
      prompt: row.message,
      background: true,
      title: row.name ?? "Heartbeat",
      ...(row.model_json === null ? {} : { model: JSON.parse(row.model_json) }),
    });
    this.store.setSession(row.id, sessionId);
    this.store.setRunSession(runId, sessionId);
  }

  /** Compacts the heartbeat's idle session when its latest run left it above the threshold; whether it started. */
  private async compactIfPending(row: AutomationRow, sessionId: string): Promise<boolean> {
    const pending = this.store.pendingCompaction(row.id);
    if (!pending) return false;
    // Its session was replaced since: the new one has nothing to compact.
    if (pending.session_id !== sessionId) {
      this.store.setCompaction(pending.id, "failed", "Its session was replaced");
      return false;
    }
    try {
      await this.sessions.compact(sessionId, { instructions: COMPACTION_INSTRUCTIONS });
      this.store.setCompaction(pending.id, "started");
      return true;
    } catch (error) {
      this.store.setCompaction(pending.id, "failed", message(error));
      return false;
    }
  }
}
