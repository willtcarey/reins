import type { Database } from "bun:sqlite";

/**
 * Process startup (never handler installation: a previous hot-reload handler may still be delivering
 * against this database): a restart cannot prove the outcome of a dispatch it interrupted, so every
 * interrupted (`dispatching`) command is requeued and redelivered once its node connects. Every outbox
 * command is replay-safe (prompt/steer by Pi's durable `reinsId`, an absolute setModel), so a replay
 * converges whether or not the node received it. The row keeps its rowid, so it stays ahead of later
 * work for its session. Failed commands whose notification the restart lost are deleted (a failure is
 * never retried).
 *
 * The server's storage is every session's only copy (ADR-015): `session.provision` and `session.hydrate`
 * rows left from before it are dropped (the node creates a session's lane when it first opens it), and
 * every session is placed on its source's node (`placement_status` is no longer read, and a failed
 * provision or move no longer leaves an error to show). Returns the number of interrupted dispatches.
 */
export function recoverInterruptedDispatches(db: Database): number {
  return db.transaction(() => {
    db.exec("DELETE FROM node_command_outbox WHERE json_extract(command_json, '$.op') IN ('session.provision', 'session.hydrate')");
    db.exec("UPDATE sessions SET placement_status = 'provisioned', status_error = NULL WHERE placement_status != 'provisioned' OR status_error IS NOT NULL");
    const { changes } = db.run("UPDATE node_command_outbox SET state = 'queued' WHERE state = 'dispatching'");
    db.exec("DELETE FROM node_command_outbox WHERE state = 'failed'");
    return changes;
  })();
}
