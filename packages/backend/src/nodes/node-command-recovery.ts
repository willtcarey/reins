import type { Database } from "bun:sqlite";

/**
 * Startup of a handler load, once the previous load stopped (never while another dispatcher may still be
 * delivering against this database): a restart cannot prove the outcome of a dispatch it interrupted, so every
 * interrupted (`dispatching`) command is requeued and redelivered once its node connects. Every outbox
 * command is replay-safe (prompt/steer by Pi's durable `reinsId`, an absolute setModel), so a replay
 * converges whether or not the node received it. The row keeps its rowid, so it stays ahead of later
 * work for its session. Failed commands whose notification the restart lost are deleted (a failure is
 * never retried).
 * Returns the number of interrupted dispatches.
 */
export function recoverInterruptedDispatches(db: Database): number {
  return db.transaction(() => {
    const { changes } = db.run("UPDATE node_command_outbox SET state = 'queued' WHERE state = 'dispatching'");
    db.exec("DELETE FROM node_command_outbox WHERE state = 'failed'");
    return changes;
  })();
}
