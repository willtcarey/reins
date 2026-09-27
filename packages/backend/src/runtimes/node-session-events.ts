import type { ServerState } from "../state.js";
import type { NodeSessionReports } from "./internal-node.js";
import { SessionManager } from "./session-manager.js";
import { getSession } from "../session-store.js";
import { getDb } from "../db.js";
import { recordNodeLifecycle } from "../node-replica.js";
import { logger } from "../logger.js";

/** Internal node reports. Live `session.event`s are broadcast to browsers as sent (best effort; their
 * images are already attachment references). Durable
 * `session.started`/`session.settled` drive the session's SessionInstance lifecycle effects (activity,
 * metadata, child settlement), each applied at most once, atomically with the session's lifecycle
 * watermark. The node delivers a
 * session's reports in occurrence order and only after the previous one was acknowledged, so a
 * settlement never overtakes a newer run's start and no per-session instance needs to be kept. */
export function nodeSessionReports(state: ServerState): NodeSessionReports {
  const manager = new SessionManager(state);
  return {
    event: ({ sessionId, seq, missed, event }) => {
      if (missed > 0) logger.warn(`Missed ${missed} node session event(s) before ${sessionId}#${seq}`);
      const row = getSession(sessionId);
      if (!row) return;
      // The node stored any inline image with `attachment.store` first: event images are references.
      manager.broadcast({ type: "event", sessionId, projectId: row.project_id, event });
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
