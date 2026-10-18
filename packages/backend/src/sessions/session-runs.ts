/**
 * A session's run, as the server records it. A session's runtime (on the server, ADR-029) applies each
 * run's end itself, with this module's code (`runSettled`) against the process's database and broadcast,
 * no app involved, to the session row: the unread flag (`activity_state` `finished`) and the last run end
 * Reins applied (its outcome with Pi's operation ID and who ended it).
 * It also resumes, at process start, the runs a process exit left pending in Pi (`pi/run-state.ts`), and
 * answers "wait until it settles" from the live runtimes, Pi's storage and that record. Whether a run is
 * in progress is the live runtime's (`sessionActivity`, `models/session-activity.ts`): nothing durable
 * records it.
 */
import { finalReply, type FinalReply } from "../session-runtime/events.js";
import { getDb } from "../app-globals.js";
import { logger } from "../logger.js";
import { loadActiveMessages, loadBranchMessages } from "../messages-store.js";
import { storedInput } from "../pi-session-store.js";
import { getSession, sessionBusy, updateActivityState, updateSessionMeta, type SessionRow } from "../session-store.js";
import type { AppState, OpenSessions, ServerProcess } from "../state.js";
import { createBroadcast } from "../models/broadcast.js";
import { Sessions, submitToSession } from "../models/sessions.js";
import { sessionActivity } from "../models/session-activity.js";
import { pendingPiOperations, readNewestRunResult, readOperationResult, readPendingPiOperation } from "../pi/run-state.js";

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
 * Applies a run's settlement: records it (for waits: its outcome, with Pi's operation ID and who ended
 * it), persists the run's model metadata and sets the session `finished`, unless the run started (Pi's
 * `startedAt`) before its task closed (closing a task quiets the runs in flight). For a child, two ordered steps: first its
 * final reply (on the report's `tipId` branch) is steered to its parent under `childReportKey`, through
 * the parent's live runtime and in its submission chain (`submitToSession`), then the settlement is
 * committed, clearing the child's activity. A crash between them after Pi's end leaves the settlement
 * unapplied (Pi has nothing pending, so recovery does not see it); the parent heard of it once. A reply
 * that cannot be read, or a
 * parent that cannot receive it (outside the child's project/task, its node removed, admission failed), is
 * logged and leaves the child `finished` without a report. It needs only the process (its database and
 * broadcast), so a runtime applies its own run's end with or without an app. Other errors propagate.
 */
export async function runSettled(serverProcess: ServerProcess, { sessionId, runId, source, status, error, metadata, tipId }: SessionSettled): Promise<void> {
  const outcome: RunSettlement = { status, ...(error ? { error: { ...(error.code === undefined ? {} : { code: error.code }), message: error.message } } : {}) };
  const session = requireSession(sessionId);
  // A child's report goes first: its parent's runtime commits it on its own (keyed by this run's end).
  let reported = false;
  if (session.parent_session_id) {
    try {
      await reportToParent(serverProcess, session, session.parent_session_id, childReportKey(sessionId, runId, source), finalReply(loadBranchMessages(sessionId, tipId)), outcome);
      reported = true;
    } catch (failure) {
      logger.error(`Failed to report session ${sessionId} settlement to its parent:`, failure);
    }
  }
  getDb().transaction(() => {
    recordRunSettled(sessionId, { operationId: runId, source, ...outcome });
    if (metadata.model?.provider && metadata.model.modelId) {
      updateSessionMeta(sessionId, { modelProvider: metadata.model.provider, modelId: metadata.model.modelId, thinkingLevel: metadata.thinkingLevel ?? undefined });
    }
    const activityState = reported || runStartedBeforeTaskClosed(sessionId, runId) ? null : "finished";
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
   * Resolves once the session is at rest, with its final reply and its last run's outcome
   * (`lastRunOutcome`), or `timeout` after `timeoutMs`; rejects with an `AbortError` when `signal` aborts.
   * The session is at rest once it is not busy (`sessionActivity`: no submission in progress, its live
   * runtime neither admitting nor driving input nor applying a run's end) and no input of `inputs`
   * (clientIds the caller submitted) is still queued as steering in Pi. An input in the transcript needs
   * nothing more: its run is in progress (the session is busy) or ended, which Pi commits at once; one
   * that failed never reaches storage and expects no run. Between checks it waits for a change
   * (`nextChange`).
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
        if (readPendingPiOperation(getDb(), sessionId)?.operationId !== operationId || sessionBusy(sessionId, state.process.sessions)) return;
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
      const queued = (clientId: string) => {
        const admitted = storedInput(sessionId, clientId);
        return admitted !== null && "queued" in admitted;
      };
      for (;;) {
        const atRest = sessionActivity(requireSession(sessionId), state.process.sessions) === "idle" && !inputs.some(queued);
        if (atRest) return replyResult(sessionId, finalReply(loadActiveMessages(sessionId)), lastRunOutcome(sessionId) ?? undefined);
        if (Date.now() >= deadline) return { sessionId, status: "timeout", result: null, error: null };
        await nextChange(state.process.sessions, sessionId, deadline - Date.now(), signal);
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
/** The latest settlement: the last run end Reins applied, with Pi's operation ID and who ended it
 * (absent from records older than them that migration 056 found no lane for, or that runtimes on older
 * code wrote after it). */
export interface LatestSettlement extends RunSettlement { operationId?: string; source?: SessionSettled["source"] }

/** The session's latest settlement, or null before its first. */
export function latestSettlement(sessionId: string): LatestSettlement | null {
  const row = getDb().query<{ settlement_json: string | null }, [string]>("SELECT settlement_json FROM sessions WHERE id = ?").get(sessionId);
  if (!row?.settlement_json) return null;
  const record: LatestSettlement = JSON.parse(row.settlement_json);
  return record;
}

/**
 * How the session's last run ended, for a wait: the last run end Reins applied when it names Pi's newest
 * run result (Reins' outcome, with its `checkout_unavailable` override) or the operation Pi has in
 * progress (a run Reins gave up, a storage fault: ends Pi cannot express); otherwise Pi's newest run
 * result, a run end whose settlement never applied (an exit cut it off). Reins' record when Pi has no run
 * result; null when neither has one.
 */
function lastRunOutcome(sessionId: string): RunSettlement | null {
  const applied = latestSettlement(sessionId);
  const newest = readNewestRunResult(getDb(), sessionId);
  if (!newest) return applied;
  if (applied?.operationId !== undefined
    && (applied.operationId === newest.operationId || applied.operationId === readPendingPiOperation(getDb(), sessionId)?.operationId)) {
    return applied;
  }
  // `declined` is a compaction's or navigation's, never a run's.
  const status = newest.status === "declined" ? "aborted" : newest.status;
  return { status, ...(newest.error ? { error: { code: newest.error.code, message: newest.error.message } } : {}) };
}

/** Pi's operation `operationId` started before (or as) the session's task closed. When it started is
 * Pi's record of it: its result's `startedAt`, or its meta's while it is in progress (a run given up). */
function runStartedBeforeTaskClosed(sessionId: string, operationId: string): boolean {
  const closedAt = getDb().query<{ closed_at: string | null }, [string]>(
    "SELECT tasks.closed_at FROM sessions JOIN tasks ON tasks.id = sessions.task_id WHERE sessions.id = ?").get(sessionId)?.closed_at;
  if (!closedAt) return false;
  const pending = readPendingPiOperation(getDb(), sessionId);
  const startedAt = readOperationResult(getDb(), sessionId, operationId)?.startedAt
    ?? (pending?.operationId === operationId ? pending.startedAt : undefined);
  return startedAt !== undefined && startedAt <= Date.parse(closedAt);
}

/** This is the latest settlement: the last run end Reins applied. */
function recordRunSettled(sessionId: string, { operationId, source, status, error }: RunSettlement & { operationId: string; source: SessionSettled["source"] }): void {
  getDb().query("UPDATE sessions SET settlement_json = ?1 WHERE id = ?2")
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

/** How often a wait checks the session when nothing it waits on signals: a session opened meanwhile, a
 * settlement applied outside a runtime, a queued input. */
export const WAIT_POLL_MS = 250;

/**
 * Resolves on the next change a wait may find the session at rest after, within `ms`: its live runtime's
 * next idle edge (`whenIdle`), its submission chain draining or its opening ending, or after
 * `WAIT_POLL_MS`. Only what is in flight is awaited (a busy runtime, a chain or opening in progress, each
 * leaving the open sessions before a wait wakes on it), so with nothing in flight it sleeps on the timer
 * rather than spinning. Rejects with an `AbortError` when `signal` aborts.
 */
function nextChange(sessions: OpenSessions, sessionId: string, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const runtime = sessions.live.get(sessionId)?.runtime;
  const inFlight = [
    runtime?.isBusy() ? runtime.whenIdle() : undefined,
    sessions.submissions.get(sessionId),
    sessions.opening.get(sessionId),
  ].filter(change => change !== undefined);
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const wake = () => { done(); resolve(); };
    const abort = () => { done(); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(wake, Math.min(WAIT_POLL_MS, ms));
    signal?.addEventListener("abort", abort, { once: true });
    for (const change of inFlight) void change.then(wake, wake);
  });
}
