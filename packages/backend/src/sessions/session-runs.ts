/**
 * A session's run, as the server sees it. Sessions run on nodes (the server runs none), so a run is what
 * the node's durable reports leave on the session row: the run in progress (`run_id`, from its
 * `session.started` until its `session.settled`), when the latest run started (`run_started_at`), activity (`activity_state`) and the latest settlement
 * (its outcome, a count of settlements applied and the storage's `harness_next_seq` when it was applied).
 * This module applies those reports (and resumes, or settles, runs a node lost), and answers "wait until it settles"
 * from the same projections plus the command outbox. "Is the session busy?" is `sessionActivity`
 * (`models/session-activity.ts`).
 */
import { finalReply, type FinalReply, type SessionSettled } from "@reins/node-protocol";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import { loadActiveMessages, loadBranchMessages } from "../messages-store.js";
import { pendingInputs } from "../nodes/node-command-store.js";
import { storedInput } from "../pi-session-store.js";
import { getSession, updateActivityState, updateSessionMeta, type SessionRow } from "../session-store.js";
import type { Broadcast } from "../models/broadcast.js";
import { Sessions, type SessionNodes } from "../models/sessions.js";

export interface SessionWaitResult {
  sessionId: string;
  status: "idle" | "completed" | "failed" | "cancelled" | "timeout";
  result: string | null;
  error: string | null;
}

/** A session's runs: lifecycle reports from its node, crash recovery and bounded waits. */
export interface SessionRuns {
  /** Applies `session.started`: marks the session running, atomically with its run record. A repeated
   * start of the run in progress (Pi reports it again on in-run compaction) applies nothing; a start for
   * a run that already settled applies (Pi resumed it). Errors propagate. */
  runStarted(sessionId: string, runId: string): void;
  /**
   * Applies `session.settled` in one transaction: records the settlement (for waits), persists the run's
   * model metadata, and for a child reads its final reply (on the report's `tipId` branch) and steers it
   * to its parent, clearing the child's activity; otherwise the session is `finished`, unless the run
   * started before its task closed (closing a task quiets the runs in flight). A reply that cannot
   * be read, or a parent outside the child's project/task, is logged and leaves the child `finished`
   * without a misleading report. A settlement may arrive without a start (a resumed run). A repeat of the
   * last applied settlement (its `reportId`, resent after a lost reply) applies nothing. Other errors
   * propagate.
   */
  runSettled(report: SessionSettled): void;
  /**
   * Recovery (ADR-021), when node `nodeId` negotiates: every session on that node (its source's node) the
   * server still sees running whose ID the node did not list in `node.hello` as having a run in progress
   * lost its run (a restart, a reload, a dropped link that closed its runtimes). Each is resumed on the node
   * (`Sessions.resume`), within `resumes`, and stays running. It is settled as interrupted (failed, through
   * `runSettled`, under the run ID of its last start) when `resumes` refuses it, when the resume fails or
   * when the node finds nothing to resume, unless its run settled or restarted meanwhile. Resolves once
   * every lost run is resumed or settled.
   */
  recoverLostRuns(nodeId: string, liveSessions: readonly string[], resumes: ResumeBudget): Promise<void>;
  /**
   * Resolves once the session is at rest, with its final reply and the latest settlement's outcome, or
   * `timeout` after `timeoutMs`; rejects with an `AbortError` when `signal` aborts. It polls (every 10ms)
   * only server projections: it tracks every input it sees pending in the outbox and resolves once none
   * is still queued or being delivered, the session is not running, and every tracked input the node
   * admitted is covered by a settlement. Admission is proven by the session's storage, not by an outbox
   * row (settled commands are deleted): an admitted prompt/steer is a `reinsInput` there keyed by its
   * clientId (`storedInput`); one still queued as steering awaits a run; a transcript entry is covered
   * once the latest settlement was applied after it was committed (its seq is below the settlement's
   * `nextSeq`). An input that failed never reaches storage and expects no run. Limit: an input admitted
   * before the wait began whose `session.started` is still in flight reads as idle.
   */
  waitForSettlement(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<SessionWaitResult>;
}

/** `broadcast` announces activity changes; `nodes` delivers a child's report to its parent. */
export function sessionRuns({ broadcast, nodes }: { broadcast: Broadcast; nodes: SessionNodes }): SessionRuns {
  const notifyUpdated = (sessionId: string) => {
    const row = getSession(sessionId);
    if (row) broadcast({ type: "session_updated", sessionId, projectId: row.project_id });
  };

  const runs: SessionRuns = {
    runStarted(sessionId, runId) {
      const applied = getDb().transaction(() => {
        if (!recordRunStarted(sessionId, runId)) return false;
        updateActivityState(sessionId, "running");
        return true;
      })();
      if (applied) notifyUpdated(sessionId);
    },

    runSettled({ sessionId, reportId, status, error, metadata, tipId }) {
      const outcome: RunSettlement = { status, ...(error ? { error: { ...(error.code === undefined ? {} : { code: error.code }), message: error.message } } : {}) };
      const applied = getDb().transaction(() => {
        if (!recordRunSettled(sessionId, reportId, outcome)) return false;
        if (metadata.model?.provider && metadata.model.modelId) {
          updateSessionMeta(sessionId, { modelProvider: metadata.model.provider, modelId: metadata.model.modelId, thinkingLevel: metadata.thinkingLevel ?? undefined });
        }
        const session = requireSession(sessionId);
        let activityState: SessionRow["activity_state"] = runStartedBeforeTaskClosed(sessionId) ? null : "finished";
        if (session.parent_session_id) {
          try {
            reportToParent(new Sessions(nodes), session, session.parent_session_id, finalReply(loadBranchMessages(sessionId, tipId)), outcome);
            activityState = null;
          } catch (failure) {
            logger.error(`Failed to report session ${sessionId} settlement to its parent:`, failure);
          }
        }
        updateActivityState(sessionId, activityState);
        return true;
      })();
      if (applied) notifyUpdated(sessionId);
    },

    async recoverLostRuns(nodeId, liveSessions, resumes) {
      const live = new Set(liveSessions);
      const lost = getDb().query<{ id: string; run_id: string | null }, [string]>(
        "SELECT sessions.id, sessions.run_id FROM sessions JOIN sources ON sources.id = sessions.source_id WHERE sessions.activity_state = 'running' AND sources.node_id = ?",
      ).all(nodeId).filter(row => !live.has(row.id));
      const settleInterrupted = (sessionId: string, runId: string | null, why: string) => {
        // Its run settled (a report delivered meanwhile) or a new one started: that report stands.
        if (runInProgress(sessionId) !== runId || getSession(sessionId)?.activity_state !== "running") return;
        logger.warn(`Session ${sessionId} lost its run on node ${nodeId} (${why}); settling it as interrupted`);
        runs.runSettled({
          sessionId, runId: runId ?? `interrupted-${crypto.randomUUID()}`, reportId: crypto.randomUUID(), status: "failed", error: { message: INTERRUPTED },
          // No runtime facts: the session row keeps its model.
          metadata: { model: null, thinkingLevel: null }, tipId: null,
        });
      };
      const sessions = new Sessions(nodes);
      await Promise.all(lost.map(async ({ id, run_id: runId }) => {
        if (!resumes.take(id)) { settleInterrupted(id, runId, `resumed ${AUTO_RESUME_LIMIT} times within ${AUTO_RESUME_WINDOW_MS / 60_000} minutes`); return; }
        logger.info(`Session ${id} lost its run on node ${nodeId}; resuming it`);
        try {
          const { started } = await sessions.resume(id);
          if (!started) settleInterrupted(id, runId, "nothing to resume");
        } catch (error) {
          settleInterrupted(id, runId, `resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    },

    async waitForSettlement(sessionId, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      const inputs = new Map<string, string>(); // outbox command ID → clientId
      for (;;) {
        const row = requireSession(sessionId);
        const pending = new Set<string>();
        for (const input of pendingInputs(sessionId)) { inputs.set(input.id, input.clientId); pending.add(input.id); }
        const settlement = latestSettlement(sessionId);
        const awaitingRun = (clientId: string) => {
          const admitted = storedInput(sessionId, clientId);
          if (!admitted) return false;
          return "queued" in admitted || admitted.seq >= (settlement?.nextSeq ?? 0);
        };
        const busy = row.activity_state === "running"
          || [...inputs].some(([id, clientId]) => pending.has(id) || awaitingRun(clientId));
        if (!busy) return replyResult(sessionId, finalReply(loadActiveMessages(sessionId)), settlement ?? undefined);
        if (Date.now() >= deadline) return { sessionId, status: "timeout", result: null, error: null };
        await pollDelay(Math.min(10, deadline - Date.now()), signal);
      }
    },
  };
  return runs;
}

/** How many times a session's lost run is resumed automatically within `AUTO_RESUME_WINDOW_MS` before it
 * is settled as interrupted instead: a run that crashes its node would otherwise crash it forever. Every
 * session on that node spends its budget, since the server cannot tell which one caused the crash. */
export const AUTO_RESUME_LIMIT = 3;
export const AUTO_RESUME_WINDOW_MS = 10 * 60_000;

/** Automatic resumes allowed per session (`recoverLostRuns`). */
export interface ResumeBudget {
  /** Spends one of the session's resumes; false when none is left in the window. */
  take(sessionId: string): boolean;
}

/** In memory: one per hub, so a server reload starts every session's budget again. */
export function createResumeBudget({ limit = AUTO_RESUME_LIMIT, windowMs = AUTO_RESUME_WINDOW_MS, now = Date.now }: { limit?: number; windowMs?: number; now?: () => number } = {}): ResumeBudget {
  const spent = new Map<string, number[]>();
  return {
    take(sessionId) {
      const at = now();
      const recent = (spent.get(sessionId) ?? []).filter(time => at - time < windowMs);
      if (recent.length >= limit) { spent.set(sessionId, recent); return false; }
      spent.set(sessionId, [...recent, at]);
      return true;
    },
  };
}

interface RunSettlement { status: "completed" | "failed" | "aborted"; error?: { code?: string; message: string } }
/** The latest settlement: `seq` counts applied settlements, so a caller can tell whether one arrived
 * after an earlier observation; `nextSeq` is the session's `harness_next_seq` when it was applied (its
 * run's commits reach the server before its settlement, so every entry below it was committed before). */
export interface LatestSettlement extends RunSettlement { seq: number; nextSeq: number }

/** The run a `session.started` report started and no settlement has ended yet, or null. */
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

const INTERRUPTED = "The run was interrupted: its node restarted or lost its connection to the server";

function requireSession(sessionId: string): SessionRow {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);
  return row;
}

/** Steers the child's outcome to its parent, which must be in the child's project and task. */
function reportToParent(sessions: Sessions, child: SessionRow, parentSessionId: string, reply: FinalReply | null, outcome: RunSettlement): void {
  const parent = requireSession(parentSessionId);
  if (parent.project_id !== child.project_id || parent.task_id !== child.task_id) throw new Error("Parent session is outside the child's project/task scope");
  const result = replyResult(child.id, reply, outcome);
  const content = result.status === "completed"
    ? result.result ?? "Session completed."
    : result.error ? `Session ${result.status}: ${result.error}` : `Session ${result.status}.`;
  sessions.submit(parent.id, { op: "steer", content: [{ type: "text", text: content }], clientId: crypto.randomUUID(), sourceSessionId: child.id });
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
