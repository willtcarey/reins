import type { Database } from "bun:sqlite";

/**
 * A source is a location, a node and a path, used by any session: it belongs to no project, and a session
 * has a source and optionally a project (docs/plans/completed/session-locations.md, ADR-034). In one transaction:
 *
 * - each project gets a home source (`projects.home_source_id`), its default one until now: its first
 *   (lowest ID) source on a node not removed, else its first;
 * - `sources` is rebuilt without `project_id`, every row under its ID (a node and path were already
 *   unique, so no rows merge);
 * - `sessions` is rebuilt with `project_id` nullable, `source_id` required, and a task only with a
 *   project; the triggers that made a session's source belong to its project go with the old table.
 *
 * SQLite cannot drop a constrained column or a NOT NULL, hence the rebuilds, with foreign keys off so
 * dropping the old tables cascades nowhere; every foreign key is checked before the transaction commits.
 */
export function sourcesWithoutProjects(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS session_source_insert;
        DROP TRIGGER IF EXISTS session_source_update;

        ALTER TABLE projects ADD COLUMN home_source_id INTEGER REFERENCES sources(id);
        UPDATE projects SET home_source_id = (
          SELECT sources.id FROM sources LEFT JOIN nodes ON nodes.id = sources.node_id
          WHERE sources.project_id = projects.id
          ORDER BY nodes.removed_at IS NOT NULL, sources.id LIMIT 1
        );

        CREATE TABLE sources_062 (
          id INTEGER PRIMARY KEY,
          node_id TEXT NOT NULL REFERENCES nodes(id),
          path TEXT NOT NULL,
          UNIQUE(node_id, path)
        );
        INSERT INTO sources_062 (id, node_id, path) SELECT id, node_id, path FROM sources;
        DROP TABLE sources;
        ALTER TABLE sources_062 RENAME TO sources;

        CREATE TABLE sessions_062 (
          id TEXT PRIMARY KEY,
          project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          model_provider TEXT,
          model_id TEXT,
          thinking_level TEXT DEFAULT 'off',
          task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
          parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          agent_runtime_type TEXT NOT NULL DEFAULT 'pi',
          activity_state TEXT CHECK(activity_state IN ('running', 'finished')),
          harness_next_seq INTEGER NOT NULL DEFAULT 1,
          pinned_at TEXT,
          archived_at TEXT,
          source_id INTEGER NOT NULL REFERENCES sources(id),
          settlement_json TEXT CHECK(settlement_json IS NULL OR json_valid(settlement_json)),
          background INTEGER NOT NULL DEFAULT 0 CHECK(background IN (0, 1)),
          kind TEXT NOT NULL DEFAULT 'agent',
          auto_resumes TEXT,
          CHECK(task_id IS NULL OR project_id IS NOT NULL)
        );
        INSERT INTO sessions_062 (id, project_id, name, created_at, updated_at, model_provider, model_id, thinking_level, task_id,
            parent_session_id, agent_runtime_type, activity_state, harness_next_seq, pinned_at, archived_at, source_id, settlement_json,
            background, kind, auto_resumes)
          SELECT id, project_id, name, created_at, updated_at, model_provider, model_id, thinking_level, task_id,
            parent_session_id, agent_runtime_type, activity_state, harness_next_seq, pinned_at, archived_at, source_id, settlement_json,
            background, kind, auto_resumes
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_062 RENAME TO sessions;
        CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at DESC);
        CREATE INDEX idx_sessions_source ON sessions(source_id);
      `);
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error(`Foreign key violations after moving sources off projects: ${JSON.stringify(violations.slice(0, 10))}`);
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
