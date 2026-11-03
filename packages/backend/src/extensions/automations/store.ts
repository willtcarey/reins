/** The automations and their runs in the extension's database (`migrations.ts`), and their views. */

import type { Database, Location } from "@reins/sdk/server";

export type RunOutcome = "sent" | "skipped" | "running" | "completed" | "failed" | "cancelled" | "lost";
export type Compaction = "pending" | "started" | "failed";
export interface OwnSessionModel { provider: string; modelId: string; thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }

export interface AutomationRow {
  id: number;
  name: string | null;
  message: string | null;
  target: "session" | "own" | "new";
  session_id: string | null;
  created_by_session_id: string | null;
  trigger: "schedule" | "command";
  schedule: string;
  timezone: string;
  command: string | null;
  node: string | null;
  cwd: string | null;
  timeout_ms: number | null;
  once: 0 | 1;
  source_json: string | null;
  model_json: string | null;
  compact_above_tokens: number | null;
  background: 0 | 1;
  next_run_at: string;
  last_send_session_id: string | null;
  last_send_run_id: string | null;
  last_send_at: string | null;
  checks: number;
  last_check_at: string | null;
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
  exit_code: number | null;
  check_output: string | null;
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
  exitCode: number | null;
  checkOutput: string | null;
  compaction: Compaction | null;
  compactionError: string | null;
}

export type TriggerView =
  | { kind: "schedule"; schedule: string; timezone: string }
  | { kind: "command"; command: string; every: string; node: string; cwd: string | null; timeoutMs: number | null };

export interface AutomationView {
  id: number;
  name: string | null;
  message: string | null;
  target: "session" | "own" | "new";
  sessionId: string | null;
  createdBySessionId: string | null;
  trigger: TriggerView;
  once: boolean;
  source: number | Location | null;
  model: OwnSessionModel | null;
  compactAboveTokens: number | null;
  /** The sessions it starts are hidden from the browser. */
  background: boolean;
  /** Null once cancelled. */
  nextRunAt: string | null;
  checks: number;
  lastCheckAt: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  lastRun: RunView | null;
  consecutiveFailures: number;
}

export interface NewAutomation {
  name: string | null;
  message: string | null;
  target: "session" | "own" | "new";
  sessionId: string | null;
  createdBySessionId: string | null;
  trigger: "schedule" | "command";
  schedule: string;
  timezone: string;
  command: string | null;
  node: string | null;
  cwd: string | null;
  timeoutMs: number | null;
  once: boolean;
  source: number | Location | null;
  model: OwnSessionModel | null;
  compactAboveTokens: number | null;
  background: boolean;
  nextRunAt: Date;
  createdAt: Date;
}

/** Enough history to see a pattern of failures; a check every few minutes would otherwise grow without end. */
const KEPT_RUNS = 200;
const FAILURE_WINDOW = 50;

const json = (value: unknown) => value === null ? null : JSON.stringify(value);

const runView = (row: RunRow): RunView => ({
  id: row.id,
  automationId: row.automation_id,
  sessionId: row.session_id,
  outcome: row.outcome,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  output: row.output,
  error: row.error,
  exitCode: row.exit_code,
  checkOutput: row.check_output,
  compaction: row.compaction,
  compactionError: row.compaction_error,
});

export class AutomationStore {
  constructor(private readonly db: Database) {}

  create(automation: NewAutomation): AutomationRow {
    return this.db.query<AutomationRow, (string | number | null)[]>(`INSERT INTO automations
      (name, message, target, session_id, created_by_session_id, trigger, schedule, timezone, command, node, cwd, timeout_ms, once,
       source_json, model_json, compact_above_tokens, background, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
      automation.name, automation.message, automation.target, automation.sessionId, automation.createdBySessionId, automation.trigger,
      automation.schedule, automation.timezone, automation.command, automation.node, automation.cwd, automation.timeoutMs, automation.once ? 1 : 0,
      json(automation.source), json(automation.model), automation.compactAboveTokens, automation.background ? 1 : 0, automation.nextRunAt.toISOString(), automation.createdAt.toISOString(),
    )!;
  }

  get(id: number): AutomationRow | null {
    return this.db.query<AutomationRow, [number]>("SELECT * FROM automations WHERE id = ?").get(id);
  }

  /** The active ones, those due soonest first. */
  active(): AutomationRow[] {
    return this.db.query<AutomationRow, []>("SELECT * FROM automations WHERE cancelled_at IS NULL ORDER BY next_run_at, id").all();
  }

  /** Every one, or those of `sessionId` (that it messages or that it made), newest first. */
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

  /** Its own session (null: the next delivery starts one), which forgets the latest scheduled send. */
  setSession(id: number, sessionId: string | null): void {
    this.db.query("UPDATE automations SET session_id = ?, last_send_session_id = NULL, last_send_run_id = NULL, last_send_at = NULL WHERE id = ?").run(sessionId, id);
  }

  recordSend(id: number, send: { sessionId: string; lastRunId: string | null; at: Date }): void {
    this.db.query("UPDATE automations SET last_send_session_id = ?, last_send_run_id = ?, last_send_at = ? WHERE id = ?")
      .run(send.sessionId, send.lastRunId, send.at.toISOString(), id);
  }

  recordCheck(id: number, { fired, at }: { fired: boolean; at: Date }): void {
    this.db.query(`UPDATE automations SET checks = checks + ?, last_check_at = ? WHERE id = ?`).run(fired ? 0 : 1, at.toISOString(), id);
  }

  cancel(id: number, reason: string, at: Date): void {
    this.db.query("UPDATE automations SET cancelled_at = ?, cancel_reason = ? WHERE id = ? AND cancelled_at IS NULL").run(at.toISOString(), reason, id);
  }

  delete(id: number): void {
    this.db.query("DELETE FROM automations WHERE id = ?").run(id);
  }

  addRun(run: {
    automationId: number; sessionId: string | null; outcome: RunOutcome; startedAt: Date; ended?: boolean; error?: string;
    check?: { exitCode: number; output: string } | null;
  }): number {
    const startedAt = run.startedAt.toISOString();
    const { id } = this.db.query<{ id: number }, (string | number | null)[]>(`INSERT INTO automation_runs
      (automation_id, session_id, outcome, started_at, ended_at, error, exit_code, check_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      run.automationId, run.sessionId, run.outcome, startedAt, run.ended ? startedAt : null, run.error ?? null, run.check?.exitCode ?? null, run.check?.output ?? null,
    )!;
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

  /** Its latest run whose compaction is still to start. */
  pendingCompaction(automationId: number): RunRow | null {
    return this.db.query<RunRow, [number]>("SELECT * FROM automation_runs WHERE automation_id = ? AND compaction = 'pending' ORDER BY id DESC LIMIT 1").get(automationId);
  }

  /** Its runs still in progress, the latest first. */
  running(automationId: number): RunRow[] {
    return this.db.query<RunRow, [number]>("SELECT * FROM automation_runs WHERE automation_id = ? AND outcome = 'running' ORDER BY id DESC").all(automationId);
  }

  /** The runs in progress on `sessionId`, the latest first: several when a message joined a run in progress. */
  runningOn(sessionId: string): RunRow[] {
    return this.db.query<RunRow, [string]>("SELECT * FROM automation_runs WHERE session_id = ? AND outcome = 'running' ORDER BY id DESC").all(sessionId);
  }

  runs(automationId: number, limit: number): RunView[] {
    return this.db.query<RunRow, [number, number]>("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?").all(automationId, limit).map(runView);
  }

  view(row: AutomationRow): AutomationView {
    const recent = this.db.query<{ outcome: RunOutcome }, [number]>(`SELECT outcome FROM automation_runs WHERE automation_id = ? AND outcome NOT IN ('skipped', 'running')
      ORDER BY id DESC LIMIT ${FAILURE_WINDOW}`).all(row.id);
    const failures = recent.findIndex(run => run.outcome !== "failed");
    const latest = this.db.query<RunRow, [number]>("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
    return {
      id: row.id,
      name: row.name,
      message: row.message,
      target: row.target,
      sessionId: row.session_id,
      createdBySessionId: row.created_by_session_id,
      trigger: row.trigger === "schedule"
        ? { kind: "schedule", schedule: row.schedule, timezone: row.timezone }
        : { kind: "command", command: row.command!, every: row.schedule, node: row.node!, cwd: row.cwd, timeoutMs: row.timeout_ms },
      once: row.once === 1,
      source: row.source_json === null ? null : JSON.parse(row.source_json),
      model: row.model_json === null ? null : JSON.parse(row.model_json),
      compactAboveTokens: row.compact_above_tokens,
      background: row.background === 1,
      nextRunAt: row.cancelled_at === null ? row.next_run_at : null,
      checks: row.checks,
      lastCheckAt: row.last_check_at,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      lastRun: latest && runView(latest),
      consecutiveFailures: failures < 0 ? recent.length : failures,
    };
  }
}
