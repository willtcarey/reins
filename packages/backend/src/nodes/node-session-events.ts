import type { ServerState } from "../state.js";
import type { NodeSessionEvent, ServerHandlers } from "../node-link/server-peer.js";
import { broadcastFrame, createBroadcast, sessionEventFrame } from "../models/broadcast.js";
import { logger } from "../logger.js";
import { sessionBusTelemetry } from "../models/session-bus-telemetry.js";
import { sessionRuns } from "../sessions/session-runs.js";

/** `event` also receives the session's project, read while fencing it. */
export interface NodeSessionReports extends Pick<ServerHandlers, "started" | "settled"> {
  event(input: NodeSessionEvent & { projectId: number }): void;
}

/** Node reports. Live `session.event`s are broadcast to every browser as the node serialized them,
 * unparsed (best effort; the node guarantees their images are attachment references).
 * `session.started`/`session.settled` are the session's run lifecycle (`sessionRuns`). The node sends a
 * session's reports once each, in occurrence order, each after the previous one was acknowledged, so a
 * settlement never overtakes a newer run's start. A report the node could not deliver is not resent;
 * `settleInterruptedRuns` settles its run. */
export function nodeSessionReports(state: ServerState): NodeSessionReports {
  const runs = sessionRuns({ broadcast: createBroadcast(state.clients), nodes: state.nodes });
  return {
    event: ({ sessionId, projectId, seq, missed, emittedAt, event }) => {
      const receivedAt = sessionBusTelemetry.now();
      if (missed > 0) logger.warn(`Missed ${missed} node session event(s) before ${sessionId}#${seq}`);
      broadcastFrame(state.clients, sessionEventFrame(sessionId, projectId, seq, emittedAt, event));
      sessionBusTelemetry.relayed({ sessionId, missed, emittedAt, bytes: event.length, receivedAt, clients: state.clients.size });
    },
    started: ({ sessionId, runId }) => runs.runStarted(sessionId, runId),
    settled: report => runs.runSettled(report),
  };
}
