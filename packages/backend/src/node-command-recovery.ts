import type { Database } from "bun:sqlite";

/**
 * Process startup (never handler installation: a previous hot-reload handler may still be delivering
 * against this database): a restart cannot prove the outcome of a dispatch it interrupted, and such
 * dispatches are not replayed. In one transaction an interrupted provision marks its session
 * `provision_failed`, an interrupted move `move_failed` (the session stays where the move left it), and
 * every interrupted command is deleted, together with failed commands whose notification the restart
 * lost. Work queued behind them is delivered normally.
 */
export function recoverInterruptedDispatches(db: Database): void {
  db.transaction(() => {
    db.exec(`UPDATE sessions SET
        placement_status = CASE json_extract(o.command_json, '$.op') WHEN 'session.provision' THEN 'provision_failed' ELSE 'move_failed' END,
        status_error = CASE json_extract(o.command_json, '$.op') WHEN 'session.provision'
          THEN 'Provisioning was interrupted by a server restart' ELSE 'Move was interrupted by a server restart' END
      FROM node_command_outbox o
      WHERE o.session_id = sessions.id AND o.state = 'dispatching'
        AND json_extract(o.command_json, '$.op') IN ('session.provision', 'session.hydrate')`);
    db.exec("DELETE FROM node_command_outbox WHERE state IN ('dispatching', 'failed')");
  })();
}
