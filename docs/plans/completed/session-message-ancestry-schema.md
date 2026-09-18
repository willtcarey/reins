# Session message ancestry schema

Status: **completed**

## Scope

Add only the agreed structural fields to `session_messages`:

- retain the integer primary key used by public message pages;
- add nullable `parent_id` referencing `session_messages(id)`;
- add nullable `harness_id`, unique within a session when present;
- migrate existing rows into one linear parent chain per session in `seq` order, leaving each first row parentless and every existing `harness_id` null.

Persist new linear rows with explicit parent relationships, retain those relationships when snapshots update rows in place, and expose stored `parent_id` through the existing message-page `parentId` field. The parent foreign key uses `ON DELETE SET NULL` to prevent dangling ancestry without recursively deleting children. Snapshot truncation remains suffix-only, compaction remains append-only outside the active window, and task/session deletion behavior remains otherwise unchanged.

## Non-goals

No runtime identity adoption, branch APIs or UI, alternate persistence backend, metadata changes, dependency changes, or changes to public message IDs.

## Validation

Follow red-green-refactor with real SQLite migration and persistence tests. Run focused tests, the full suite, typecheck, lint, and diff checks.
