/** The automations and their runs in the extension's database (`migrations.ts`), and their views. */

import type { Database, Location } from "@reins/sdk/server";

export type AutomationKind = "wake" | "heartbeat";
export type RunOutcome = "sent" | "skipped" | "running" | "completed" | "failed" | "cancelled" | "lost";
export type Compaction = "pending" | "started" | "failed";
export interface HeartbeatModel { provider: string; modelId: string; thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }

export interface AutomationRow {
  id: number;
  kind: AutomationKind;
  name: string | null;
  session_id: string | null;
  created_by_session_id: string | null;
  message: string;
  schedule: string;
  timezone: string;
  source_json: string | null;
  model_json: string | null;
  compact_above_tokens: number | null;
  next_run_at: string;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface RunRow {
  id: number;
  automation_id: number;
  session_id: string | null;
  outcome: RunOutcome;
  started_at: string;
  ended_at: string | null;
  output: string | null;
  error: string | null;
  compaction: Compaction | null;
  compaction_error: string | null;
}

export interface RunView {
  id: number;
  automationId: number;
  sessionId: string | null;
  outcome: RunOutcome;
  startedAt: string;
  endedAt: string | null;
  output: string | null;
  error: string | null;
  compaction: Compaction | null;
  compactionError: string | null;
}

export interface AutomationView {
  id: number;
  kind: AutomationKind;
  name: string | null;
  sessionId: string | null;
  createdBySessionId: string | null;
  message: string;
  schedule: string;
  timezone: string;
  source: number | Location | null;
  model: HeartbeatModel | null;
  compactAboveTokens: number | null;
  /** Null once cancelled. */
  nextRunAt: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  lastRun: RunView | null;
  /** How many of its latest runs failed in a row. */
  consecutiveFailures: number;
}

export interface NewAutomation {
  kind: AutomationKind;
  name: string | null;
  sessionId: string | null;
  createdBySessionId: string | null;
  message: string;
  schedule: string;
  timezone: string;
  source: number | Location | null;
  model: HeartbeatModel | null;
  compactAboveTokens: number | null;
  nextRunAt: Date;
  createdAt: Date;
}

/** Enough history to see a pattern of failures; a wake-up every few minutes would otherwise grow without end. */
const KEPT_RUNS = 200;
const FAILURE_WINDOW = 50;

const runView = (row: RunRow): RunView => ({
  id: row.id,
  automationId: row.automation_id,
  sessionId: row.session_id,
  outcome: row.outcome,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  output: row.output,
  error: row.error,
  compaction: row.compaction,
  compactionError: row.compaction_error,
});

export class AutomationStore {
  constructor(private readonly db: Database) {}

  create(automation: NewAutomation): AutomationRow {
    return this.db.query<AutomationRow, (string | number | null)[]>(`INSERT INTO automations
      (kind, name, session_id, created_by_session_id, message, schedule, timezone, source_json, model_json, compact_above_tokens, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
      automation.kind, automation.name, automation.sessionId, automation.createdBySessionId, automation.message, automation.schedule,
      automation.timezone, automation.source === null ? null : JSON.stringify(automation.source),
      automation.model === null ? null : JSON.stringify(automation.model), automation.compactAboveTokens,
      automation.nextRunAt.toISOString(), automation.createdAt.toISOString(),
    )!;
  }

  get(id: number): AutomationRow | null {
    return this.db.query<AutomationRow, [number]>("SELECT * FROM automations WHERE id = ?").get(id);
  }

  /** The active ones, those due soonest first. */
  active(): AutomationRow[] {
    return this.db.query<AutomationRow, []>("SELECT * FROM automations WHERE cancelled_at IS NULL ORDER BY next_run_at, id").all();
  }

  /** Every one, or those of `sessionId` (that it wakes or that it made), newest first. */
  list({ sessionId, includeCancelled }: { sessionId?: string; includeCancelled: boolean }): AutomationRow[] {
    const where = [
      ...(includeCancelled ? [] : ["cancelled_at IS NULL"]),
      ...(sessionId === undefined ? [] : ["(session_id = $session OR created_by_session_id = $session)"]),
    ];
    return this.db.query<AutomationRow, Record<string, string>>(`SELECT * FROM automations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`)
      .all(sessionId === undefined ? {} : { $session: sessionId });
  }

  setNextRun(id: number, at: Date): void {
    this.db.query("UPDATE automations SET next_run_at = ? WHERE id = ?").run(at.toISOString(), id);
  }

  setSession(id: number, sessionId: string | null): void {
    this.db.query("UPDATE automations SET session_id = ? WHERE id = ?").run(sessionId, id);
  }

  cancel(id: number, reason: string, at: Date): void {
    this.db.query("UPDATE automations SET cancelled_at = ?, cancel_reason = ? WHERE id = ? AND cancelled_at IS NULL").run(at.toISOString(), reason, id);
  }

  addRun(run: { automationId: number; sessionId: string | null; outcome: RunOutcome; startedAt: Date; ended?: boolean; error?: string }): number {
    const startedAt = run.startedAt.toISOString();
    const { id } = this.db.query<{ id: number }, (string | number | null)[]>(`INSERT INTO automation_runs (automation_id, session_id, outcome, started_at, ended_at, error)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(run.automationId, run.sessionId, run.outcome, startedAt, run.ended ? startedAt : null, run.error ?? null)!;
    this.db.query(`DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN
      (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ${KEPT_RUNS})`).run(run.automationId, run.automationId);
    return id;
  }

  setRunSession(runId: number, sessionId: string): void {
    this.db.query("UPDATE automation_runs SET session_id = ? WHERE id = ?").run(sessionId, runId);
  }

  endRun(runId: number, end: { outcome: RunOutcome; at: Date; output?: string | null; error?: string | null }): void {
    this.db.query("UPDATE automation_runs SET outcome = ?, ended_at = ?, output = ?, error = ? WHERE id = ?")
      .run(end.outcome, end.at.toISOString(), end.output ?? null, end.error ?? null, runId);
  }

  setCompaction(runId: number, compaction: Compaction, error: string | null = null): void {
    this.db.query("UPDATE automation_runs SET compaction = ?, compaction_error = ? WHERE id = ?").run(compaction, error, runId);
  }

  delete(id: number): void {
    this.db.query("DELETE FROM automations WHERE id = ?").run(id);
  }

  /** Its latest run whose compaction is still to start. */
  pendingCompaction(automationId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM automation_runs WHERE automation_id = ? AND compaction = 'pending' ORDER BY id DESC LIMIT 1").get(automationId);
  }

  latestRun(automationId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 1").get(automationId);
  }

  /** The run in progress on `sessionId`, the latest first. */
  runningOn(sessionId: string): RunRow | null {
    return this.db.query<RunRow, [string]>("SELECT * FROM automation_runs WHERE session_id = ? AND outcome = 'running' ORDER BY id DESC LIMIT 1").get(sessionId);
  }

  runs(automationId: number, limit: number): RunView[] {
    return this.db.query<RunRow, [number, number]>("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?").all(automationId, limit).map(runView);
  }

  view(row: AutomationRow): AutomationView {
    const recent = this.db.query<{ outcome: RunOutcome }, [number]>(`SELECT outcome FROM automation_runs WHERE automation_id = ? AND outcome NOT IN ('skipped', 'running')
      ORDER BY id DESC LIMIT ${FAILURE_WINDOW}`).all(row.id);
    const failures = recent.findIndex(run => run.outcome !== "failed");
    const latest = this.latestRun(row.id);
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      sessionId: row.session_id,
      createdBySessionId: row.created_by_session_id,
      message: row.message,
      schedule: row.schedule,
      timezone: row.timezone,
      source: row.source_json === null ? null : JSON.parse(row.source_json),
      model: row.model_json === null ? null : JSON.parse(row.model_json),
      compactAboveTokens: row.compact_above_tokens,
      nextRunAt: row.cancelled_at === null ? row.next_run_at : null,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      lastRun: latest && runView(latest),
      consecutiveFailures: failures < 0 ? recent.length : failures,
    };
  }
}
