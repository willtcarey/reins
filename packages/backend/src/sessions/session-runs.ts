/**
 * A session's run, as the server records it. A session's runtime (on the server, ADR-029) applies each
 * run's lifecycle itself, with this module's code (`runStarted`, `runSettled`) against the process's
 * database and broadcast, no app involved, to the session row: the run in progress (`run_id`, from its
 * `started` until its settlement), when the latest run started (`run_started_at`), activity
 * (`activity_state`) and the last run end Reins applied (its outcome with Pi's operation ID and who ended
 * it, a count of settlements applied and the storage's `harness_next_seq` when it was applied). It also
 * resumes, at process start, the runs a process exit left pending in Pi (`pi/run-state.ts`), and answers
 * "wait until it settles" from the same projections plus the live runtimes. "Is the session busy?" is `sessionActivity` (`models/session-activity.ts`).
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
import { runtimeBusy, sessionActivity } from "../models/session-activity.js";
import { pendingPiOperations, readPendingPiOperation } from "../pi/run-state.js";

export interface SessionWaitResult {
  sessionId: string;
  status: "idle" | "completed" | "failed" | "cancelled" | "timeout";
  result: string | null;
  error: string | null;
}

/** A run's settlement as its runtime reports it. `runId` is Pi's operation ID. `source` is who ended it:
 * `pi` for Pi's `run_end` (its outcome, or the runtime's `checkout_unavailable` override of it), `reins`
 * for an end Pi cannot express (a run given up as interrupted, or a storage fault: Pi left it pending).
 * `metadata` is the runtime's model selection at settlement. `tipId` comes from Pi's durable `run_end`: a
 * child's reply is projected from that exact branch, never from a newer main tip; null for a storage fault
 * or an interrupted run with no trustworthy completed branch. */
export interface SessionSettled {
  sessionId: string;
  runId: string;
  source: "pi" | "reins";
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
 * Applies a run's settlement: records it (for waits: its outcome, with Pi's operation ID and who ended
 * it), persists the run's model metadata and sets the session `finished`, unless the run started before
 * its task closed (closing a task quiets the runs in flight). For a child, two ordered steps: first its
 * final reply (on the report's `tipId` branch) is steered to its parent under `childReportKey`, through
 * the parent's live runtime and in its submission chain (`submitToSession`), then the settlement is
 * committed, clearing the child's activity. A crash between them leaves the child running; recovery
 * settles it as interrupted without reporting again (`reportedBefore`). A reply that cannot be read, or a
 * parent that cannot receive it (outside the child's project/task, its node removed, admission failed), is
 * logged and leaves the child `finished` without a report. A settlement may arrive without a start (a
 * resumed run). Like `runStarted`, it needs only the process. Other errors propagate.
 */
export async function runSettled(serverProcess: ServerProcess, { sessionId, runId, source, status, error, metadata, tipId }: SessionSettled): Promise<void> {
  const outcome: RunSettlement = { status, ...(error ? { error: { ...(error.code === undefined ? {} : { code: error.code }), message: error.message } } : {}) };
  const session = requireSession(sessionId);
  // A child's report goes first: its parent's runtime commits it on its own (keyed by this run's end).
  let reported = false;
  if (session.parent_session_id) {
    try {
      if (source === "reins" && reportedBefore(sessionId, session.parent_session_id)) reported = true;
      else {
        await reportToParent(serverProcess, session, session.parent_session_id, childReportKey(sessionId, runId, source), finalReply(loadBranchMessages(sessionId, tipId)), outcome);
        reported = true;
      }
    } catch (failure) {
      logger.error(`Failed to report session ${sessionId} settlement to its parent:`, failure);
    }
  }
  getDb().transaction(() => {
    recordRunSettled(sessionId, { operationId: runId, source, ...outcome });
    if (metadata.model?.provider && metadata.model.modelId) {
      updateSessionMeta(sessionId, { modelProvider: metadata.model.provider, modelId: metadata.model.modelId, thinkingLevel: metadata.thinkingLevel ?? undefined });
    }
    const activityState: SessionRow["activity_state"] = reported || runStartedBeforeTaskClosed(sessionId) ? null : "finished";
    updateActivityState(sessionId, activityState);
  })();
  notifyUpdated(serverProcess, sessionId);
}

/** The key a child's report of a run end is steered to its parent under, which Pi recognises when it is
 * steered again: the child and Pi's operation ID, and for an end Reins made (`source: "reins"`) the suffix
 * `:interrupted`, since the same operation may still end in Pi after a manual resume, another report. */
function childReportKey(childId: string, operationId: string, source: SessionSettled["source"]): string {
  return `child-report:${childId}:${operationId}${source === "reins" ? ":interrupted" : ""}`;
}

/** A run Reins is about to end itself (Pi still has it in progress, so Pi never ended it), whose report
 * code before the operation-ID key already steered to the parent before an exit cut its settlement off,
 * under `child-report:<childId>:<n>` (`n` the count the settlement would have had). It is not reported
 * again. */
function reportedBefore(childId: string, parentId: string): boolean {
  const { settlement_count: count } = getDb().query<{ settlement_count: number }, [string]>(
    "SELECT settlement_count FROM sessions WHERE id = ?").get(childId)!;
  return storedInput(parentId, `child-report:${childId}:${count + 1}`) !== null;
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
   * Recovery at process start (ADR-021, ADR-029): every run Pi has in progress (`pendingRuns`) lost its
   * driver when the previous process exited (a SIGTERM suspended it, or a crash cut it off). Each is
   * resumed in a new live runtime (`Sessions.resume`), within its automatic resume budget. It is given up
   * instead (settled as interrupted: failed, `source: "reins"`) when its budget is spent or the resume
   * fails, unless it ended or is being driven meanwhile. A run given up before is left alone. Resolves
   * once every run is resumed or given up.
   */
  recoverInterruptedRuns(): Promise<void>;
  /** Gives up as interrupted (failed, with `message`) every run Pi has in progress (`pendingRuns`) on node
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
  /** Gives Pi's operation `operationId` up: settles it as failed with `message`, Reins' end of it. */
  const settleAsInterrupted = (sessionId: string, operationId: string, message: string) => runSettled(state.process, {
    sessionId, runId: operationId, source: "reins", status: "failed", error: { message },
    // No runtime facts: the session row keeps its model.
    metadata: { model: null, thinkingLevel: null }, tipId: null,
  });

  return {
    async recoverInterruptedRuns() {
      const interrupted = pendingRuns();
      const giveUp = async (sessionId: string, operationId: string, why: string) => {
        // It ended, or its runtime (a submission) took it up meanwhile: that stands.
        if (readPendingPiOperation(getDb(), sessionId)?.operationId !== operationId || runtimeBusy(sessionId, state.process.sessions)) return;
        logger.warn(`Session ${sessionId}'s run was interrupted (${why}); giving it up`);
        await settleAsInterrupted(sessionId, operationId, INTERRUPTED);
      };
      const sessions = new Sessions(state, createBroadcast(state.process));
      await Promise.all(interrupted.map(async ({ sessionId: id, operationId }) => {
        if (!takeAutoResume(id)) { await giveUp(id, operationId, `resumed ${AUTO_RESUME_LIMIT} times within ${AUTO_RESUME_WINDOW_MS / 60_000} minutes`); return; }
        logger.info(`Session ${id}'s run was interrupted; resuming it`);
        try {
          const { started } = await sessions.resume(id);
          if (!started) await giveUp(id, operationId, "nothing to resume");
        } catch (error) {
          await giveUp(id, operationId, `resume failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    },

    async interruptRunsOn(nodeId, message, except = new Set()) {
      for (const { sessionId, operationId } of pendingRuns()) {
        if (except.has(sessionId) || !onNode(sessionId, nodeId)) continue;
        logger.warn(`Session ${sessionId} was running on node ${nodeId}, which was removed; giving its run up as interrupted`);
        await settleAsInterrupted(sessionId, operationId, message);
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

/** The run is no longer in progress and this is the latest settlement: the last run end Reins applied. */
function recordRunSettled(sessionId: string, { operationId, source, status, error }: RunSettlement & { operationId: string; source: SessionSettled["source"] }): void {
  getDb().query(`UPDATE sessions SET run_id = NULL, settlement_count = settlement_count + 1, settlement_json = ?1,
    settlement_next_seq = harness_next_seq WHERE id = ?2`)
    .run(JSON.stringify({ operationId, source, status, ...(error ? { error } : {}) }), sessionId);
}

const INTERRUPTED = "The run was interrupted: the server restarted";

/** The runs Pi has in progress (an exit cut them off, or a runtime drives them now) that Reins has not
 * given up on: the session's last recorded run end does not name the operation with `source: "reins"`. */
function pendingRuns(): Array<{ sessionId: string; operationId: string }> {
  return pendingPiOperations(getDb()).filter(({ sessionId, operationId }) => {
    const row = getDb().query<{ settlement_json: string | null }, [string]>("SELECT settlement_json FROM sessions WHERE id = ?").get(sessionId);
    const record: { operationId?: string; source?: string } | null = row?.settlement_json ? JSON.parse(row.settlement_json) : null;
    return !(record?.source === "reins" && record.operationId === operationId);
  });
}

/** Session `sessionId`'s source is on node `nodeId`. */
function onNode(sessionId: string, nodeId: string): boolean {
  return getDb().query("SELECT 1 FROM sessions JOIN sources ON sources.id = sessions.source_id WHERE sessions.id = ? AND sources.node_id = ?")
    .get(sessionId, nodeId) !== null;
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
