import type { ServerState } from "../state.js";
import type { NodeSessionReports } from "./node-server-handlers.js";
import { SessionManager } from "./session-manager.js";
import { broadcastFrame, sessionEventFrame } from "../models/broadcast.js";
import { getDb } from "../db.js";
import { recordNodeLifecycle } from "../node-replica.js";
import { logger } from "../logger.js";
import { sessionBusTelemetry } from "../models/session-bus-telemetry.js";

/** Node reports. Live `session.event`s are broadcast to every browser as the node serialized them,
 * unparsed (best effort; the node guarantees their images are attachment references). Durable
 * `session.started`/`session.settled` drive the session's SessionInstance lifecycle effects (activity,
 * metadata, child settlement), each applied at most once, atomically with the session's lifecycle
 * watermark. The node delivers a
 * session's reports in occurrence order and only after the previous one was acknowledged, so a
 * settlement never overtakes a newer run's start and no per-session instance needs to be kept. */
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
