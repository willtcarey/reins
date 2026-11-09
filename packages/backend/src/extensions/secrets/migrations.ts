/** The secrets extension's database (`reins.db`). The values are in `reins.secrets`, under `values/<handle>`. */

import type { Migration } from "@reins/sdk/server";

export const secretsMigrations: readonly Migration[] = [
  {
    id: "001_requests_and_secrets",
    up: db => db.exec(`
      -- A session's open request: deleted once the user submits or cancels it.
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        purpose TEXT,
        -- [{ name, description }], in the order asked.
        fields_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- A stored value's record. Its handle is what the session was given; whoever has it can read the value.
      CREATE TABLE secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        handle TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `),
  },
];
