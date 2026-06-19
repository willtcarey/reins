# Persist Session Activity State Server-Side

## Problem

Session activity indicators (`running` green dots and `finished` amber unread dots) were previously transient frontend state. Reloads, reconnects, missed WebSocket events, and multiple tabs could disagree about whether a session was active or unread.

The branch moved activity into server-managed session metadata so reconnects, refreshes, and other clients reconcile from one authoritative source.

## Final Behavior

The `sessions` table has nullable `activity_state`:

| Value | Meaning | UI |
|---|---|---|
| `NULL` | idle or already viewed | no dot |
| `running` | runtime is actively streaming | green dot |
| `finished` | runtime ended and completed work is unread | amber dot |

State transitions are server-owned:

| Trigger | Transition |
|---|---|
| runtime `agent_start` | `NULL`/`finished` -> `running` |
| runtime `agent_end` | `running` -> `finished` |
| user views a finished active session | `finished` -> `NULL` |
| task close cleanup | finished task-session activity -> `NULL`; running activity is preserved |

Delegate sessions (`parent_session_id IS NOT NULL`) do not participate in activity tracking. Delegate runtime activity is ignored/cleared, and the parent session remains the visible activity indicator.

## Backend Changes

### Migration

**File:** `packages/backend/src/migrations.ts`

Added migration `021_add_session_activity_state`:

```sql
ALTER TABLE sessions ADD COLUMN activity_state TEXT CHECK(activity_state IN ('running', 'finished'))
```

### Session persistence and queries

**Files:**

- `packages/backend/src/session-store.ts`
- `packages/backend/src/models/sessions.ts`

Added server-side helpers to:

- persist `activity_state`
- ignore delegate-session activity
- list sessions with non-null activity for snapshots
- clear finished activity for closed task sessions
- mark finished activity as viewed
- broadcast `session_updated` whenever persisted activity changes

`Sessions.activeSessions()` reconciles stale persisted `running` rows against live runtime state. If a backend restart or crash left a row marked `running` with no streaming runtime, it is downgraded to `finished` before being returned in the snapshot.

### Runtime observer

**File:** `packages/backend/src/runtimes/runtime-persistence-observer.ts`

The runtime persistence observer now persists activity transitions:

- `agent_start` -> `running`
- `agent_end` -> `finished`

Message persistence remains tied to turn/agent/compaction completion as before.

### REST API

**File:** `packages/backend/src/routes/sessions.ts`

Added:

- `GET /api/sessions/activity` — returns all sessions with non-null activity as `{ id, projectId, taskId, activityState }`
- `PATCH /api/sessions/:sessionId/activity` — marks finished activity as viewed (`finished` -> `NULL`); running/idle states no-op

Activity changes use the existing `session_updated` broadcast so clients fetch canonical session/list data instead of handling a separate activity event type.

## Frontend Changes

### Server-authoritative cache

**Files:**

- `packages/frontend/src/models/stores/session-cache.ts`
- `packages/frontend/src/models/stores/projects-store.ts`
- `packages/frontend/src/models/stores/project-store.ts`
- `packages/frontend/src/models/stores/active-session-store.ts`

Activity is stored as `activityState` on cached session metadata in `SessionCache`. Project, task, session, sidebar, and title/badge indicators derive from the cache.

`ProjectsStore.fetchActivitySnapshot()` loads `/api/sessions/activity` on initial WebSocket connect, reconnect, and browser resume. It also clears locally cached activity for sessions absent from the snapshot.

`ActiveSessionStore.markViewed()` clears finished activity optimistically when the active session is viewed, then calls `PATCH /api/sessions/:sessionId/activity`; failures roll back the cache entry.

### Raw runtime events no longer mutate activity

The frontend no longer changes notification dots directly from `agent_start` / `agent_end` WebSocket events. Those events still drive active chat streaming state and diff refresh timing, but activity indicators wait for backend-persisted state via:

- `session_updated` reconciliation
- session detail/list responses
- `/api/sessions/activity` snapshots

### Browser sleep / resume reconciliation

A sleeping laptop can miss terminal WebSocket messages without always causing an immediate reconnect. AppStore now uses the same server reconciliation path for reconnects and resume signals (`focus`, `online`, `pageshow`, and visible `visibilitychange`): project list, activity snapshot, loaded project stores, active session metadata, and messages are refreshed from the server.

## Streaming and Compaction Scope

This work persists notification activity only.

- `activity_state` represents session-level notification dots.
- Runtime streaming status is still exposed in session detail as `state.isStreaming` for active-session reconciliation.
- Active chat render state (`isStreaming`, streaming blocks, `isCompacting`) remains in `ChatState` and is driven by live events.
- Compaction summaries are persisted as message history, but compaction in-progress UI is not persisted as activity state.

## Tests Added / Updated

Representative coverage includes:

- migration/default `activity_state` behavior
- runtime observer `agent_start` / `agent_end` persistence
- delegate sessions excluded from activity tracking
- `GET /api/sessions/activity` snapshots, including stale-running reconciliation
- `PATCH /api/sessions/:sessionId/activity` viewed behavior
- task close clearing finished activity while preserving running activity
- reconnect/resume snapshot fetches in AppStore/ProjectsStore
- ProjectStore/ProjectsStore selectors deriving activity from `SessionCache`
- ActiveSessionStore viewed optimistic update and rollback
