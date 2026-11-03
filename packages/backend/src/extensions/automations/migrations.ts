/** The automations extension's database (`reins.db`): its migrations, which the host applies before it registers. */

import type { Migration } from "@reins/sdk/server";

export const automationsMigrations: readonly Migration[] = [
  {
    id: "001_automations",
    up: db => db.exec(`
      CREATE TABLE automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('wake', 'heartbeat')),
        name TEXT,
        -- A wake-up's session; a heartbeat's hidden session, null until it starts one.
        session_id TEXT,
        created_by_session_id TEXT,
        -- A wake-up's message, a heartbeat's prompt.
        message TEXT NOT NULL,
        schedule TEXT NOT NULL,
        timezone TEXT NOT NULL,
        -- A heartbeat's: where its session works (a source ID or a location) and its model, as JSON.
        source_json TEXT,
        model_json TEXT,
        compact_above_tokens INTEGER,
        next_run_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cancelled_at TEXT,
        cancel_reason TEXT
      );
      CREATE INDEX automations_active ON automations (cancelled_at, next_run_at);
      CREATE TABLE automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        session_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'skipped', 'running', 'completed', 'failed', 'cancelled', 'lost')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        output TEXT,
        error TEXT,
        compaction TEXT CHECK (compaction IN ('pending', 'started', 'failed')),
        compaction_error TEXT
      );
      CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, id);
      CREATE INDEX automation_runs_by_session ON automation_runs (session_id, outcome);
    `),
  },
];
