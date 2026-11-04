/** The automations extension's database (`reins.db`): its migrations, which the host applies before it registers. */

import type { Migration } from "@reins/sdk/server";

export const automationsMigrations: readonly Migration[] = [
  {
    id: "001_automations",
    up: db => db.exec(`
      CREATE TABLE automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        -- Null: a command's output is the message.
        message TEXT,
        -- 'session': a session it messages (session_id); 'own': a hidden session of its own (session_id null until it starts one);
        -- 'new': a new session at each delivery (in its runs).
        target TEXT NOT NULL CHECK (target IN ('session', 'own', 'new')),
        session_id TEXT,
        created_by_session_id TEXT,
        -- 'schedule': due at schedule; 'command': command checked at schedule (an interval), firing on exit code 0.
        trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'command')),
        schedule TEXT NOT NULL,
        timezone TEXT NOT NULL,
        command TEXT,
        node TEXT,
        cwd TEXT,
        timeout_ms INTEGER,
        once INTEGER NOT NULL DEFAULT 0 CHECK (once IN (0, 1)),
        -- The sessions it starts ('own', 'new'): where they work (a source ID or a location, as JSON), their project
        -- (null: none; not a reference, as the project is the core's) and their model (JSON).
        source_json TEXT,
        project_id INTEGER,
        model_json TEXT,
        compact_above_tokens INTEGER,
        -- The sessions it starts are hidden from the browser ('own' always; 'new' when asked).
        background INTEGER NOT NULL DEFAULT 1 CHECK (background IN (0, 1)),
        next_run_at TEXT NOT NULL,
        -- After its latest scheduled send: the session, and its latest ended run then (lastRunId).
        last_send_session_id TEXT,
        last_send_run_id TEXT,
        last_send_at TEXT,
        -- A command trigger's checks that did not fire.
        checks INTEGER NOT NULL DEFAULT 0,
        last_check_at TEXT,
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
        exit_code INTEGER,
        check_output TEXT,
        compaction TEXT CHECK (compaction IN ('pending', 'started', 'failed')),
        compaction_error TEXT
      );
      CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, id);
      CREATE INDEX automation_runs_by_session ON automation_runs (session_id, outcome);
    `),
  },
];
