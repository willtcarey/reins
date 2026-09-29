/**
 * TEST HELPER ONLY: the server's side of `storage.read`/`storage.commit` (as the backend serves them in
 * `node-server-handlers.ts`), over Pi's storage on a database with the shared Pi tables (a test's `piDb()`
 * from `@reins/pi-sql-storage`'s `test-db.ts`). Every request and result is copied through JSON, as it
 * would cross the wire. A session's row is created on first use, as if the server had created the session.
 */
import type { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT, list as listAddress, value as valueAddress, type Storage, type StoredValue, type Write } from "@earendil-works/pi-agent-core";
import type { StorageRead, StorageReadResult } from "@reins/node-protocol";
import { PiStorageAdapter } from "@reins/pi-sql-storage";
import type { StorageServer } from "../remote-storage.js";

const wire = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));

/** A storage server over `db` (returned too, for assertions on what the server holds). */
export function piStorageServer(db: Database): StorageServer & { db: Database } {
  const storage = (sessionId: string) => {
    db.query("INSERT OR IGNORE INTO sessions (id) VALUES (?)").run(sessionId);
    return new PiStorageAdapter(db, sessionId);
  };
  return {
    db,
    readStorage: async input => wire(await readPiStorage(storage(input.sessionId), wire(input))),
    commitStorage: async ({ sessionId, writes }) => wire(await storage(sessionId).commit(wire<Write[]>(writes), BACKGROUND_CONTEXT)),
  };
}

async function readPiStorage(storage: Storage, read: StorageRead): Promise<StorageReadResult> {
  switch (read.op) {
    case "getEntries": return { op: read.op, entries: [...(await storage.getEntries(read.args.ids, BACKGROUND_CONTEXT)).values()] };
    case "getValue": {
      const stored = await storage.getValue(valueAddress(read.args.namespace, read.args.key), BACKGROUND_CONTEXT);
      return { op: read.op, value: stored ? wireValue(stored) : null };
    }
    case "scanValues": return { op: read.op, values: (await storage.scanValues(valueAddress(read.args.namespace, read.args.key), BACKGROUND_CONTEXT)).map(wireValue) };
    case "readList": return { op: read.op, elements: await storage.readList(listAddress(read.args.namespace, read.args.key), read.args.options, BACKGROUND_CONTEXT) };
    case "scanBranch": return { op: read.op, entries: await storage.scanBranch(read.args, BACKGROUND_CONTEXT) };
    case "scanBranchStructure": return { op: read.op, entries: await storage.scanBranchStructure(read.args, BACKGROUND_CONTEXT) };
    case "scanEntries": return { op: read.op, entries: await storage.scanEntries(read.args, BACKGROUND_CONTEXT) };
    case "scanUsage": return { op: read.op, rows: await storage.scanUsage(read.args, BACKGROUND_CONTEXT) };
    case "getStats": return { op: read.op, stats: await storage.getStats(BACKGROUND_CONTEXT) };
  }
}

const wireValue = ({ address, value, seq }: StoredValue<unknown>) => ({ namespace: address.namespace, key: address.key, value, seq });
