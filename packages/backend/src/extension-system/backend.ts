/** Every backend part, built in or added, starts here (docs/dev/server-sdk.md *Lifecycle*). */

import type { Database, Disposer, Migration, ServerExtension } from "@reins/sdk/server";
import type { ExtensionStorage } from "../database.js";
import { logger } from "../logger.js";
import type { ExtensionHost } from "./host.js";

export interface RunningBackend {
  readonly storage: ExtensionStorage;
  readonly migrations: readonly Migration[];
  dispose(): Promise<void>;
}

/** Carries the storage it had opened, so the report can still show its migrations. */
export class BackendFailure extends Error {
  constructor(
    readonly stage: "storage" | "migration" | "register",
    readonly storage: ExtensionStorage | null,
    readonly migrations: readonly Migration[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BackendFailure";
  }
}

/** A migration that fails is rolled back; those before it stay. */
export function startBackend(name: string, extension: ServerExtension, { host, openStorage }: {
  host: ExtensionHost;
  openStorage: (name: string) => ExtensionStorage;
}): RunningBackend {
  const migrations = extension.migrations ?? [];
  let storage: ExtensionStorage;
  try {
    storage = openStorage(name);
  } catch (error) {
    throw new BackendFailure("storage", null, migrations, error);
  }
  try {
    migrate(storage.db, migrations, name);
  } catch (error) {
    throw new BackendFailure("migration", storage, migrations, error);
  }
  const connection = host.connect(name, storage);
  let dispose: Disposer | undefined;
  try {
    // An added extension's register function may return nothing, whatever its type says.
    dispose = extension.register(connection.sdk);
  } catch (error) {
    void connection.disconnect();
    throw new BackendFailure("register", storage, migrations, error);
  }
  connection.start();
  return { storage, migrations, dispose: () => connection.disconnect(dispose) };
}

function migrate(db: Database, migrations: readonly Migration[], extension: string): void {
  const ids = new Set<string>();
  for (const { id } of migrations) {
    if (typeof id !== "string" || !id) throw new Error("A migration's id must be a non-empty string");
    if (ids.has(id)) throw new Error(`Two migrations have the id ${id}`);
    ids.add(id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reins_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(db.query<{ id: string }, []>("SELECT id FROM reins_migrations").all().map(row => row.id));
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO reins_migrations (id) VALUES (?)").run(migration.id);
    })();
    logger.info(`  Extension ${extension}: migration applied: ${migration.id}`);
  }
}
