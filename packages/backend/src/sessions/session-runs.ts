/**
 * A session's run, as the server records it. A session's runtime (on the server, ADR-029) applies each
 * run's lifecycle itself, with this module's code (`runStarted`, `runSettled`) against the process's
 * database and broadcast, no app involved, to the session row: the run in progress (`run_id`, from its
 * `started` until its settlement), when the latest run started (`run_started_at`), activity
 * (`activity_state`) and the latest settlement (its outcome, a count of settlements applied and the
 * storage's `harness_next_seq` when it was applied). It also resumes, at process start, the runs a
 * process exit interrupted, and answers "wait until it settles" from the same projections plus the live
 * runtimes. "Is the session busy?" is `sessionActivity` (`models/session-activity.ts`).
 */
import { finalReply, type FinalReply } from "../session-runtime/events.js";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import { loadActiveMessages, loadBranchMessages } from "../messages-store.js";
import { storedInput } from "../pi-session-store.js";
import { getSession, updateActivityState, updateSessionMeta, type SessionRow } from "../session-store.js";
import type { AppState, ServerProcess } from "../state.js";
import { createBroadcast } from "../models/broadcast.js";
import { Sessions, submitToSession } from "../models/sessions.js";
import { sessionActivity } from "../models/session-activity.js";

export interface SessionWaitResult {
  sessionId: string;
  status: "idle" | "completed" | "failed" | "cancelled" | "timeout";
  result: string | null;
  error: string | null;
}

/** A run's settlement as its runtime reports it. `metadata` is the runtime's model selection at
 * settlement. `tipId` comes from Pi's durable `run_end`: a child's reply is projected from that exact
 * branch, never from a newer main tip; null for a storage fault or an interrupted run with no trustworthy
 * completed branch. `reportId` names this settlement: a repeat of the session's last applied settlement
 * applies nothing. */
export interface SessionSettled {
  sessionId: string;
  runId: string;
  reportId: string;
  status: "completed" | "failed" | "aborted";
  error?: { code?: string; message: string };
  metadata: { model: { provider: string; modelId: string } | null; thinkingLevel: string | null };
  tipId: string | null;
}

/**
 * Applies a run's `started`, as its runtime reports it (`lifecycleReports` in `session-runtime/build.ts`):
 * marks the session running, atomically with its run record, and announces it. A repeated start of the
 * run in progress (Pi reports it again on in-run compaction) applies nothing; a start for a run that
 * already settled applies (Pi resumed it). It needs only the process (its database and broadcast), so a
 * runtime applies its own lifecycle with or without an app. Errors propagate.
 */
export function runStarted(serverProcess: ServerProcess, sessionId: string, runId: string): void {
  const applied = getDb().transaction(() => {
    if (!recordRunStarted(sessionId, runId)) return false;
    updateActivityState(sessionId, "running");
    return true;
  })();
  if (applied) notifyUpdated(serverProcess, sessionId);
}

/**
 * Applies a run's settlement: records it (for waits), persists the run's model metadata and sets the
 * session `finished`, unless the run started before its task closed (closing a task quiets the runs in
 * flight). For a child, two ordered steps: first its final reply (on the report's `tipId` branch) is
 * steered to its parent under `child-report:<childId>:<n>` (`n`: this settlement's count), through the
 * parent's live runtime and in its submission chain (`submitToSession`), then the settlement is committed,
 * clearing the child's activity. A crash between them leaves the child running; recovery settles it and
 * steers again under the same key, which Pi recognises as a replay. A reply that cannot be read, or a
 * parent that cannot receive it (outside the child's project/task, its node removed, admission failed), is
 * logged and leaves the child `finished` without a report. A settlement may arrive without a start (a
 * resumed run). A repeat of the last applied settlement (its `reportId`) applies nothing. Like
 * `runStarted`, it needs only the process. Other errors propagate.
 */
export async function runSettled(serverProcess: ServerProcess, { sessionId, reportId, status, error, metadata, tipId }: SessionSettled): Promise<void> {
  const outcome: RunSettlement = { status, ...(error ? { error: { ...(error.code === undefined ? {} : { code: error.code }), message: error.message } } : {}) };
  const session = requireSession(sessionId);
  const record = getDb().query<{ settlement_count: number; last_settlement_id: string | null }, [string]>(
    "SELECT settlement_count, last_settlement_id FROM sessions WHERE id = ?").get(sessionId)!;
  if (record.last_settlement_id === reportId) return;
  // A child's report goes first: its parent's runtime commits it on its own (keyed by this settlement).
  let reported = false;
  if (session.parent_session_id) {
    try {
      await reportToParent(serverProcess, session, session.parent_session_id, `child-report:${sessionId}:${record.settlement_count + 1}`, finalReply(loadBranchMessages(sessionId, tipId)), outcome);
      reported = true;
    } catch (failure) {
      logger.error(`Failed to report session ${sessionId} settlement to its parent:`, failure);
    }
  }
  const applied = getDb().transaction(() => {
    if (!recordRunSettled(sessionId, reportId, outcome)) return false;
    if (metadata.model?.provider && metadata.model.modelId) {
      updateSessionMeta(sessionId, { modelProvider: metadata.model.provider, modelId: metadata.model.modelId, thinkingLevel: metadata.thinkingLevel ?? undefined });
    }
    const activityState: SessionRow["activity_state"] = reported || runStartedBeforeTaskClosed(sessionId) ? null : "finished";
    updateActivityState(sessionId, activityState);
    return true;
  })();
  if (applied) notifyUpdated(serverProcess, sessionId);
}

/** Announces the session's row changed to every browser. */
function notifyUpdated(serverProcess: ServerProcess, sessionId: string): void {
  const row = getSession(sessionId);
  if (row) createBroadcast(serverProcess)({ type: "session_updated", sessionId, projectId: row.project_id });
}

/** A session's runs as an app handles them: recovery at process start, interrupting the runs of a removed
 * node and bounded waits. */
export interface SessionRuns {
  /**
   * Recovery at process start (ADR-021, ADR-029): every session the server sees running lost its run when
   * the previous process exited (a SIGTERM suspended it, or a crash cut it off). Each is resumed in a new
   * live runtime (`Sessions.resume`), within its automatic resume budget, and stays running. It is
   * settled as interrupted (failed) instead when its budget is spent, when the resume fails or when there
   * is nothing to resume, unless its run settled or restarted meanwhile. Resolves once every run is
   * resumed or settled.
   */
  recoverInterruptedRuns(): Promise<void>;
  /** Settles as interrupted (failed, with `message`) every run the server sees in progress on node
   * `nodeId` (its sessions' source's node) except those of `except` (live runtimes that report their own
   * end): the node was removed. */
  interruptRunsOn(nodeId: string, message: string, except?: ReadonlySet<string>): Promise<void>;
  /**
   * Resolves once the session is at rest, with its final reply and the latest settlement's outcome, or
   * `timeout` after `timeoutMs`; rejects with an `AbortError` when `signal` aborts. It polls (every 10ms):
   * the session is at rest once it is not busy (`sessionActivity`: not running, no submission in progress
   * and its live runtime neither admitting nor driving input) and every input of `inputs` (clientIds the
   * caller submitted) Pi admitted is covered by a settlement: still queued as steering it awaits a run; a
   * transcript entry is covered once the latest settlement was applied after it was committed (its seq is
   * below the settlement's `nextSeq`). An input that failed never reaches storage and expects no run.
   */
  waitForSettlement(sessionId: string, timeoutMs: number, options?: { signal?: AbortSignal; inputs?: readonly string[] }): Promise<SessionWaitResult>;
}

/** `state` reaches the live runtimes (recovery, waits). */
export function sessionRuns(state: AppState): SessionRuns {
  /** Settles the run as failed with `message`, as its runtime would, under the run ID of its last start. */
  const settleAsInterrupted = (sessionId: string, runId: string | null, message: string) => runSettled(state.process, {
    sessionId, runId: runId ?? `interrupted-${crypto.randomUUID()}`, reportId: crypto.randomUUID(), status: "failed", error: { message },
    // No runtime facts: the session row keeps its model.
    metadata: { model: null, thinkingLevel: null }, tipId: null,
  });

  return {
    async recoverInterruptedRuns() {
      const interrupted = getDb().query<{ id: string; run_id: string | null }, []>("SELECT id, run_id FROM sessions WHERE activity_state = 'running'").all();
      const settleInterrupted = async (sessionId: string, runId: string | null, why: string) => {
        // Its run settled (its runtime reported) or a new one started: that report stands.
        if (runInProgress(sessionId) !== runId || getSession(sessionId)?.activity_state !== "running") return;
        logger.warn(`Session ${sessionId}'s run was interrupted (${why}); settling it as interrupted`);
        await settleAsInterrupted(sessionId, runId, INTERRUPTED);
      };
      const sessions = new Sessions(state, createBroadcast(state.process));
      await Promise.all(interrupted.map(async ({ id, run_id: runId }) => {
        if (!takeAutoResume(id)) { await settleInterrupted(id, runId, `resumed ${AUTO_RESUME_LIMIT} times within ${AUTO_RESUME_WINDOW_MS / 60_000} minutes`); return; }
        logger.info(`Session ${id}'s run was interrupted; resuming it`);
        try {
          const { started } = await sessions.resume(id);
          if (!started) await settleInterrupted(id, runId, "nothing to resume");
        } catch (error) {
          await settleInterrupted(id, runId, `resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    },

    async interruptRunsOn(nodeId, message, except = new Set()) {
      for (const { id, run_id: runId } of runningOn(nodeId)) {
        if (except.has(id)) continue;
        logger.warn(`Session ${id} was running on node ${nodeId}, which was removed; settling its run as interrupted`);
        await settleAsInterrupted(id, runId, message);
      }
    },

    async waitForSettlement(sessionId, timeoutMs, { signal, inputs = [] } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = requireSession(sessionId);
        const settlement = latestSettlement(sessionId);
        const awaitingRun = (clientId: string) => {
          const admitted = storedInput(sessionId, clientId);
          if (!admitted) return false;
          return "queued" in admitted || admitted.seq >= (settlement?.nextSeq ?? 0);
        };
        const busy = sessionActivity(row, state.process.sessions) !== "idle" || inputs.some(awaitingRun);
        if (!busy) return replyResult(sessionId, finalReply(loadActiveMessages(sessionId)), settlement ?? undefined);
        if (Date.now() >= deadline) return { sessionId, status: "timeout", result: null, error: null };
        await pollDelay(Math.min(10, deadline - Date.now()), signal);
      }
    },
  };
}

/** How many times a session's interrupted run is resumed automatically within `AUTO_RESUME_WINDOW_MS`
 * before it is settled as interrupted instead: a run that crashes the server would otherwise crash it at
 * every start. Every session running at a crash spends its budget, since the server cannot tell which one
 * caused it. */
export const AUTO_RESUME_LIMIT = 3;
export const AUTO_RESUME_WINDOW_MS = 10 * 60_000;

/** Spends one of the session's automatic resumes (`sessions.auto_resumes`, kept in the process's database
 * so that neither a reload nor a restart resets it); false when none is left in the window. */
export function takeAutoResume(sessionId: string, now = Date.now()): boolean {
  return getDb().transaction(() => {
    const row = getDb().query<{ auto_resumes: string | null }, [string]>("SELECT auto_resumes FROM sessions WHERE id = ?").get(sessionId);
    const times: number[] = row?.auto_resumes ? JSON.parse(row.auto_resumes) : [];
    const recent = times.filter(time => now - time < AUTO_RESUME_WINDOW_MS);
    const allowed = recent.length < AUTO_RESUME_LIMIT;
    getDb().query("UPDATE sessions SET auto_resumes = ? WHERE id = ?").run(JSON.stringify(allowed ? [...recent, now] : recent), sessionId);
    return allowed;
  })();
}

interface RunSettlement { status: "completed" | "failed" | "aborted"; error?: { code?: string; message: string } }
/** The latest settlement: `seq` counts applied settlements, so a caller can tell whether one arrived
 * after an earlier observation; `nextSeq` is the session's `harness_next_seq` when it was applied (its
 * run's commits reach the server before its settlement, so every entry below it was committed before). */
export interface LatestSettlement extends RunSettlement { seq: number; nextSeq: number }

/** The run a `started` report started and no settlement has ended yet, or null. */
export function runInProgress(sessionId: string): string | null {
  return getDb().query<{ run_id: string | null }, [string]>("SELECT run_id FROM sessions WHERE id = ?").get(sessionId)?.run_id ?? null;
}

/** The session's latest settlement, or null before its first. */
export function latestSettlement(sessionId: string): LatestSettlement | null {
  const row = getDb().query<{ settlement_count: number; settlement_json: string | null; settlement_next_seq: number | null }, [string]>(
    "SELECT settlement_count, settlement_json, settlement_next_seq FROM sessions WHERE id = ?").get(sessionId);
  if (!row?.settlement_json) return null;
  const { status, error }: RunSettlement = JSON.parse(row.settlement_json);
  return { seq: row.settlement_count, nextSeq: row.settlement_next_seq ?? 0, status, ...(error ? { error } : {}) };
}

/** False when the start is a repeat of the run in progress. */
function recordRunStarted(sessionId: string, runId: string): boolean {
  return getDb().query(`UPDATE sessions SET run_id = ?1, run_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?2 AND run_id IS NOT ?1`).run(runId, sessionId).changes > 0;
}

/** The session's latest run started before (or as) its task closed. */
function runStartedBeforeTaskClosed(sessionId: string): boolean {
  return getDb().query(`SELECT 1 FROM sessions JOIN tasks ON tasks.id = sessions.task_id
    WHERE sessions.id = ? AND sessions.run_started_at <= tasks.closed_at`).get(sessionId) !== null;
}

/** The run is no longer in progress and this is the latest settlement. False when it is a repeat of the
 * latest settlement. */
function recordRunSettled(sessionId: string, reportId: string, { status, error }: RunSettlement): boolean {
  return getDb().query(`UPDATE sessions SET run_id = NULL, settlement_count = settlement_count + 1, settlement_json = ?1,
    settlement_next_seq = harness_next_seq, last_settlement_id = ?2 WHERE id = ?3 AND last_settlement_id IS NOT ?2`)
    .run(JSON.stringify({ status, ...(error ? { error } : {}) }), reportId, sessionId).changes > 0;
}

const INTERRUPTED = "The run was interrupted: the server restarted";

/** The sessions the server sees running on node `nodeId` (its source's node), with their run. */
function runningOn(nodeId: string): Array<{ id: string; run_id: string | null }> {
  return getDb().query<{ id: string; run_id: string | null }, [string]>(
    "SELECT sessions.id, sessions.run_id FROM sessions JOIN sources ON sources.id = sessions.source_id WHERE sessions.activity_state = 'running' AND sources.node_id = ?",
  ).all(nodeId);
}

function requireSession(sessionId: string): SessionRow {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);
  return row;
}

/** Steers the child's outcome to its parent under `reinsId`; the parent must be in the child's project and task. */
async function reportToParent(serverProcess: ServerProcess, child: SessionRow, parentSessionId: string, reinsId: string, reply: FinalReply | null, outcome: RunSettlement): Promise<void> {
  const parent = requireSession(parentSessionId);
  if (parent.project_id !== child.project_id || parent.task_id !== child.task_id) throw new Error("Parent session is outside the child's project/task scope");
  const result = replyResult(child.id, reply, outcome);
  const content = result.status === "completed"
    ? result.result ?? "Session completed."
    : result.error ? `Session ${result.status}: ${result.error}` : `Session ${result.status}.`;
  await submitToSession(serverProcess, parent.id, { op: "steer", content: [{ type: "text", text: content }], clientId: reinsId, sourceSessionId: child.id });
}

/** The session's final reply with a settlement's outcome as the terminal status, when there is one. */
function replyResult(sessionId: string, last: FinalReply | null, terminal?: RunSettlement): SessionWaitResult {
  const result = last?.text ?? null;
  if (terminal?.status === "failed") {
    return { sessionId, status: "failed", result: null, error: terminal.error?.message ?? "Runtime response failed" };
  }
  if (terminal?.status === "aborted") {
    return { sessionId, status: "cancelled", result: null, error: terminal.error?.message ?? null };
  }
  return {
    sessionId,
    status: terminal?.status === "completed" ? "completed" : last?.stopReason === "aborted" ? "cancelled" : last?.stopReason === "error" ? "failed" : last ? "completed" : "idle",
    result,
    error: terminal?.status === "completed"
      ? null
      : last?.stopReason === "error" ? last.errorMessage ?? "Runtime response failed" : null,
  };
}

/** Sleeps between polls; rejects when `signal` aborts. */
function pollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
