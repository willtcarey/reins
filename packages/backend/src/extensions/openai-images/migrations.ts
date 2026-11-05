/** The openai-images extension's database (`reins.db`): its endpoints. API keys are in `reins.secrets`. */

import type { Migration } from "@reins/sdk/server";

export const openaiImagesMigrations: readonly Migration[] = [
  {
    id: "001_endpoints",
    up: db => db.exec(`
      CREATE TABLE endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        -- A JSON array of model IDs; NULL: every model the server lists.
        models TEXT,
        -- A JSON object merged into each request.
        default_parameters TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `),
  },
  {
    id: "002_random_seed",
    // 1: a request without a seed gets a random one (servers such as SGLang use a fixed seed otherwise).
    up: db => db.exec("ALTER TABLE endpoints ADD COLUMN random_seed INTEGER NOT NULL DEFAULT 0"),
  },
];
