# ADR-002: SQLite-backed Session Storage

- **Status:** Proposed
- **Date:** 2026-02-13
- **Author:** Will (with Claude)

## Context

REINS uses the pi SDK to run agent conversations. Pi stores sessions as JSONL
files under `~/.pi/agent/sessions/`, organized by working directory
(e.g. `--home--will--Workspaces--reins--/`). This creates two problems:

1. **Sessions are lost when the project directory moves.** The cwd-encoded path
   in the session directory name no longer matches.
2. **Sessions can't be related to REINS domain objects.** Pi's file-based
   storage is opaque — we can't query sessions by project, tag them, add
   metadata, or join them with other tables.

Pi's SDK offers `SessionManager.inMemory()` for running without file
persistence, and `session.messages` / `session.subscribe()` for observing
conversation state. There is no pluggable storage backend interface.

## Decision

**Use SQLite as the source of truth for session data.** Pi runs with
`SessionManager.inMemory()` and REINS owns persistence:

- A `sessions` table stores session metadata (linked to projects by FK).
- A `session_messages` table stores each message as a JSON blob, ordered
  by sequence number, forming the conversation history.
- On session creation, we create a row in `sessions` and use
  `SessionManager.inMemory()` for the pi agent.
- On each `agent_end` event (or per-message via `message_end`), we persist
  new messages to SQLite.
- On session resume, we load messages from SQLite, create a new in-memory
  pi session, and call `session.agent.replaceMessages(messages)` to hydrate.

## Schema

```sql
-- Migration: 003_create_sessions
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,              -- pi session UUID
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT,                        -- user-defined display name
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    model_provider TEXT,              -- last-used model provider
    model_id TEXT,                    -- last-used model id
    thinking_level TEXT DEFAULT 'off' -- last-used thinking level
);

-- Migration: 004_create_session_messages
CREATE TABLE session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,             -- ordering within the session
    role TEXT NOT NULL,               -- user, assistant, toolResult, etc.
    message_json TEXT NOT NULL,       -- full AgentMessage serialized as JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, seq)
);

CREATE INDEX idx_session_messages_session ON session_messages(session_id, seq);
CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at DESC);
```

## Integration Layer

A `SessionStore` module provides the bridge between pi and SQLite:

```
┌─────────────┐     subscribe(events)     ┌───────────────┐
│  Pi Agent    │ ────────────────────────▶ │  SessionStore  │
│  (in-memory) │                           │  (SQLite)      │
│              │ ◀── replaceMessages() ─── │                │
└─────────────┘      on resume             └───────────────┘
```

### Key operations

- **`createSession(projectId)`** — INSERT into `sessions`, return metadata.
  Caller creates pi session with `SessionManager.inMemory()`.
- **`persistMessages(sessionId, messages)`** — Diff against stored message
  count; INSERT only new messages. Called on `turn_end` and `agent_end` so
  completed turns survive a server restart mid-conversation.
- **`replaceAllMessages(sessionId, messages)`** — Delete and rewrite all
  stored messages. Called on `auto_compaction_end` when pi replaces the
  message array with a shorter compacted version.
- **`loadMessages(sessionId)`** — SELECT ordered messages, return parsed
  `AgentMessage[]` for `replaceMessages()`.
- **`listSessions(projectId)`** — SELECT session metadata for sidebar.
- **`updateSessionMeta(sessionId, ...)`** — Update name, model, thinking level.

### What we lose from pi's SessionManager

- **Tree structure / branching.** Pi sessions are trees with `id`/`parentId`
  on each entry. Our flat `seq`-ordered table is linear. We don't currently use
  branching in the UI, so this is acceptable. If needed later, we can add
  `parent_seq` to `session_messages`.
- **Compaction history.** Pi's tree storage is append-only — compaction adds a
  `CompactionEntry` child and advances the leaf, but the pre-compaction entries
  remain in the JSONL. You can `branch()` back to any earlier point, including
  before compaction. Our linear model is lossy here: on `auto_compaction_end`
  we call `replaceAllMessages()` which deletes stored messages and rewrites
  them with the compacted set. **There is no way to fork back to
  pre-compaction state.** To support that we'd need to store raw
  `SessionEntry` objects with their `id`/`parentId` tree relationships and
  track a leaf pointer, rather than flattening to a `seq`-ordered message
  array.
- **Other pi entry types (model changes, labels, branch summaries).** These
  are pi-specific entry types interleaved in the JSONL. We store only
  `AgentMessage` objects. Model/thinking state is tracked on the `sessions`
  row.
- **`SessionManager.list()` metadata.** Pi's listing includes `firstMessage`,
  `messageCount`, etc. We compute these from our own tables.

### What we gain

- **Sessions survive directory moves.** Linked by `project_id`, not cwd path.
- **Queryable.** Join sessions with projects, filter by date, full-text search
  on messages, aggregate token usage — all via SQL.
- **Single database.** Projects and sessions in one place, one backup target.
- **Schema evolution.** SQLite migrations are straightforward; we already have
  the pattern in `migrations.ts`.

## Consequences

- The `sessions.ts` module and `routes/sessions.ts` will be rewritten to use
  the new `SessionStore` instead of `SessionManager.open/create/list`.
- The frontend `SessionListItem` shape will change (no more `path` field;
  `id` becomes the primary key).
- WS commands (`prompt`, `steer`, `abort`) will use `sessionId` only
  (no more `sessionPath`).
- Existing pi JSONL sessions are abandoned (they were already lost on
  directory moves). No migration from JSONL to SQLite is planned.
