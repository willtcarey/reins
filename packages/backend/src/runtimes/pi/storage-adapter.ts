import type { Database } from "bun:sqlite";
import { PiStorageAdapter as HarnessSqliteStorage } from "@reins/node/pi-storage";

/** Legacy server-owned writer. Never admit a server write to a node-owned replica. */
export class PiStorageAdapter extends HarnessSqliteStorage {
  constructor(db: Database, sessionId: string, now: () => number = Date.now) {
    super(db, sessionId, now, undefined, () => {
      if (db.query<{ storage_owner: string }, [string]>(
        "SELECT storage_owner FROM sessions WHERE id = ?",
      ).get(sessionId)?.storage_owner === "internal-node") {
        throw new Error(`Node-owned session is read-only on server: ${sessionId}`);
      }
    });
  }
}
