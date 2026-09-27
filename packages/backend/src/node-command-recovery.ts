import type { Database } from "bun:sqlite";

/**
 * Process startup (never handler installation: a previous hot-reload handler may still be delivering
 * against this database): a restart cannot prove the outcome of a dispatch it interrupted, and such
 * dispatches are not replayed. In one transaction an interrupted provision marks its session
 * `provision_failed`, an interrupted move returns the session to the resting state it left (its
 * hydrate's `revertTo`: `server`, or `provisioned` on its previous source) with the reason in
 * `status_error`, and every interrupted command is deleted, together with failed commands whose
 * notification the restart lost. Work queued behind them is delivered normally (work for a session back
 * at rest hydrates it first). Returns the number of interrupted dispatches.
 */
export function recoverInterruptedDispatches(db: Database): number {
  return db.transaction(() => {
    const { interrupted } = db.query<{ interrupted: number }, []>("SELECT count(*) AS interrupted FROM node_command_outbox WHERE state = 'dispatching'").get()!;
    db.exec(`UPDATE sessions SET placement_status = 'provision_failed', status_error = 'Provisioning was interrupted by a server restart'
      FROM node_command_outbox o
      WHERE o.session_id = sessions.id AND o.state = 'dispatching' AND json_extract(o.command_json, '$.op') = 'session.provision'`);
    db.exec(`UPDATE sessions SET
        placement_status = json_extract(o.command_json, '$.revertTo.status'),
        source_id = json_extract(o.command_json, '$.revertTo.sourceId'),
        status_error = 'Move was interrupted by a server restart'
      FROM node_command_outbox o
      WHERE o.session_id = sessions.id AND o.state = 'dispatching' AND json_extract(o.command_json, '$.op') = 'session.hydrate'`);
    db.exec("DELETE FROM node_command_outbox WHERE state IN ('dispatching', 'failed')");
    return interrupted;
  })();
}
