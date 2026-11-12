/**
 * The processes the server keeps on nodes under a key (`processes`, core migration 066): the record of each, so
 * that the next app (a reload, a restart) can attach to it again, and stop it once its owner is gone
 * (`models/processes.ts`). In the main database: an owner's records must be found when the owner is gone. The
 * command and environment are kept only as a keyed hash, as environment values may be secrets.
 */

import { getDb } from "./app-globals.js";
import type { NodeProcessExit } from "./nodes/node-process.js";

/** ADR-004. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface ProcessRecord {
  owner: string;
  nodeId: string;
  key: string;
  processId: string;
  pid: number;
  commandHash: string;
  /** Where the last app's handle had read its output to: the next attach resumes there. */
  outputOffset: number;
  /** How it ended, once a handle saw it end; null while it may run. */
  ended: NodeProcessExit | null;
  startedAt: string;
}

interface Row { owner: string; node_id: string; key: string; process_id: string; pid: number; command_hash: string; output_offset: number; ended_json: string | null; started_at: string }

const COLUMNS = "owner, node_id, key, process_id, pid, command_hash, output_offset, ended_json, started_at";

function toRecord(row: Row): ProcessRecord {
  return {
    owner: row.owner, nodeId: row.node_id, key: row.key, processId: row.process_id, pid: row.pid, commandHash: row.command_hash,
    outputOffset: row.output_offset, ended: row.ended_json === null ? null : JSON.parse(row.ended_json) as NodeProcessExit, startedAt: row.started_at, // eslint-disable-line typescript-eslint/consistent-type-assertions -- written by `endProcess` only
  };
}

export function getProcess(owner: string, nodeId: string, key: string): ProcessRecord | null {
  const row = getDb().query<Row, [string, string, string]>(`SELECT ${COLUMNS} FROM processes WHERE owner = ? AND node_id = ? AND key = ?`).get(owner, nodeId, key);
  return row && toRecord(row);
}

/** In key order, then node. */
export function listProcesses(owner: string): ProcessRecord[] {
  return getDb().query<Row, [string]>(`SELECT ${COLUMNS} FROM processes WHERE owner = ? ORDER BY key, node_id`).all(owner).map(toRecord);
}

/** The owners that have records. */
export function processOwners(): string[] {
  return getDb().query<{ owner: string }, []>("SELECT DISTINCT owner FROM processes ORDER BY owner").all().map(row => row.owner);
}

/** A new process under the key, replacing the record there. */
export function recordProcess(record: Pick<ProcessRecord, "owner" | "nodeId" | "key" | "processId" | "pid" | "commandHash">): void {
  getDb().query(
    `INSERT INTO processes (owner, node_id, key, process_id, pid, command_hash) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, node_id, key) DO UPDATE SET process_id = excluded.process_id, pid = excluded.pid, command_hash = excluded.command_hash,
       output_offset = 0, ended_json = NULL, started_at = ${NOW}, updated_at = ${NOW}`,
  ).run(record.owner, record.nodeId, record.key, record.processId, record.pid, record.commandHash);
}

/** Only while the record is still this process's: a later one under the key is left alone. */
export function setProcessOffset(owner: string, nodeId: string, key: string, processId: string, offset: number): void {
  getDb().query(`UPDATE processes SET output_offset = ?, updated_at = ${NOW} WHERE owner = ? AND node_id = ? AND key = ? AND process_id = ?`)
    .run(offset, owner, nodeId, key, processId);
}

export function endProcess(owner: string, nodeId: string, key: string, processId: string, exit: NodeProcessExit): void {
  getDb().query(`UPDATE processes SET ended_json = ?, updated_at = ${NOW} WHERE owner = ? AND node_id = ? AND key = ? AND process_id = ?`)
    .run(JSON.stringify(exit), owner, nodeId, key, processId);
}

export function deleteProcess(owner: string, nodeId: string, key: string): void {
  getDb().query("DELETE FROM processes WHERE owner = ? AND node_id = ? AND key = ?").run(owner, nodeId, key);
}
