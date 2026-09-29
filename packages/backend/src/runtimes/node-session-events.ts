import type { ServerState } from "../state.js";
import type { NodeSessionReports } from "./node-server-handlers.js";
import { SessionManager } from "./session-manager.js";
import { broadcastFrame, sessionEventFrame } from "../models/broadcast.js";
import { getDb } from "../db.js";
import { recordNodeLifecycle, startedRunId } from "../node-replica.js";
import { logger } from "../logger.js";
import { sessionBusTelemetry } from "../models/session-bus-telemetry.js";

/** Node reports. Live `session.event`s are broadcast to every browser as the node serialized them,
 * unparsed (best effort; the node guarantees their images are attachment references).
 * `session.started`/`session.settled` drive the session's SessionInstance lifecycle effects (activity,
 * metadata, child settlement), each applied at most once, atomically with the session's lifecycle
 * watermark. The node sends a session's reports in occurrence order, each after the previous one was
 * acknowledged, so a settlement never overtakes a newer run's start and no per-session instance needs to
 * be kept. A report the node could not deliver is not resent; `settleInterruptedRuns` settles its run. */
export function nodeSessionReports(state: ServerState): NodeSessionReports {
  const manager = new SessionManager(state);
  return {
    event: ({ sessionId, projectId, seq, missed, emittedAt, event }) => {
      const receivedAt = sessionBusTelemetry.now();
      if (missed > 0) logger.warn(`Missed ${missed} node session event(s) before ${sessionId}#${seq}`);
      broadcastFrame(state.clients, sessionEventFrame(sessionId, projectId, seq, emittedAt, event));
      sessionBusTelemetry.relayed({ sessionId, missed, emittedAt, bytes: event.length, receivedAt, clients: state.clients.size });
    },
    started: ({ sessionId, runId }) => manager.forSession(sessionId).startedWith(
      () => recordNodeLifecycle(getDb(), sessionId, runId, "started", JSON.stringify({ runId }))),
    settled: ({ sessionId, ...report }) => {
      const { runId, status, error, metadata, reply, replyError } = report;
      manager.forSession(sessionId).settledWith(
        { runId, status, ...(error ? { error } : {}) },
        { metadata, reply, ...(replyError !== undefined ? { replyError: new Error(replyError) } : {}) },
        () => recordNodeLifecycle(getDb(), sessionId, runId, "settled", JSON.stringify(report)),
      );
    },
  };
}

const INTERRUPTED = "The run was interrupted: its node restarted or lost its connection to the server";

/**
 * Crash recovery (ADR-015), when node `nodeId` negotiates: every session on that node (its source's
 * node) the server still sees running whose ID the node did not list in `node.hello` as having a run in
 * progress is settled now as failed, through the same `settled` path as a node report. The node holds no
 * state that could report that run later (a restart, or a dropped link that closed its runtimes).
 */
export function settleInterruptedRuns(reports: Pick<NodeSessionReports, "settled">, nodeId: string, liveSessions: readonly string[]): void {
  const live = new Set(liveSessions);
  const running = getDb().query<{ id: string }, [string]>(
    "SELECT sessions.id FROM sessions JOIN sources ON sources.id = sessions.source_id WHERE sessions.activity_state = 'running' AND sources.node_id = ?",
  ).all(nodeId);
  for (const row of running) {
    if (live.has(row.id)) continue;
    logger.warn(`Session ${row.id} was running on node ${nodeId}, which no longer has the run; settling it as interrupted`);
    reports.settled({
      sessionId: row.id, runId: startedRunId(getDb(), row.id) ?? `interrupted-${crypto.randomUUID()}`, status: "failed", error: { message: INTERRUPTED },
      // No runtime facts: the session row keeps its model.
      metadata: { model: null, thinkingLevel: null }, reply: null,
    });
  }
}
