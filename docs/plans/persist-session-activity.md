# Persist Session Activity State Server-Side

## Problem

On initial page load, activity indicators (running/finished dots) don't appear until WebSocket events fire. The server already persists `activity_state` in the DB via the runtime persistence observer, but the frontend has gaps in reconciling this server-authoritative state.

### Root Causes

1. **Task sessions never applied server activity state.** `fetchTaskSessions()` fetched sessions with `activity_state` but never called `applyServerState()`. Task session activity was invisible until a WS `agent_start`/`agent_end` event fired.

2. **Initial page load had no project stores.** `handleReconnect()` fired on initial WS connect, but `refreshAll()` was a no-op because stores are lazily created on sidebar expand. Only the auto-expanded project (containing the routed session) got loaded — other projects' activity was invisible.

## Changes Made

### 1. Apply server activity state in `fetchTaskSessions()` (Frontend)

**File:** `packages/frontend/src/models/stores/project-store.ts`

Added `applyServerState()` calls in `fetchTaskSessions()` matching the pattern already used in `fetchLists()`.

### 2. Add `GET /api/activity` REST endpoint (Backend)

**Files:**
- `packages/backend/src/session-store.ts` — Added `listActiveSessions()` function that queries `SELECT id, activity_state, project_id FROM sessions WHERE activity_state IS NOT NULL`
- `packages/backend/src/routes/index.ts` — Registered `GET /api/activity` returning the result

### 3. Expose `applyServerActivity` on ProjectStore (Frontend)

**File:** `packages/frontend/src/models/stores/project-store.ts`

Added public `applyServerActivity(sessionId, activityState)` method so `ProjectsStore` can apply snapshot data to project stores.

### 4. Add `applyActivitySnapshot` on ProjectsStore (Frontend)

**File:** `packages/frontend/src/models/stores/projects-store.ts`

Added `applyActivitySnapshot(sessions)` that creates project stores on demand and applies activity states. This means activity is available even before the user expands a project in the sidebar.

### 5. Fetch activity snapshot on WS connect (Frontend)

**File:** `packages/frontend/src/models/stores/app-store.ts`

Added `_fetchActivitySnapshot()` that calls `GET /api/activity` and applies the result via `projectsStore.applyActivitySnapshot()`. Called on every WS connect (initial + reconnect).

### Tests Added

- `packages/frontend/src/__tests__/project-store.test.ts` — 2 tests for `fetchTaskSessions` applying server activity state
- `packages/frontend/src/__tests__/projects-store.test.ts` — 3 tests for `applyActivitySnapshot` (creates stores, merges, empty)
- `packages/frontend/src/__tests__/app-store-reconnect.test.ts` — 2 tests for activity snapshot fetch on connect
- `packages/backend/src/__tests__/routes/session-activity.test.ts` — 3 tests for `GET /api/activity` (returns active, empty, multi-project)

## Follow-up: Task close activity reconciliation

When a task is closed, the server clears only `finished` activity for that task's sessions. `running` activity remains visible so active work can still be seen, and future activity for closed task sessions is still persisted normally. The activity snapshot endpoint remains a raw read of persisted `running`/`finished` state with no closed-task filtering.

Cleared sessions are reconciled through standard `session_updated` broadcasts. The broadcast now optionally carries `activityState`; task-close clears emit `activityState: null`, and runtime activity transitions emit `running`/`finished`. The frontend applies this server value directly, so it no longer needs closed-task session guards or closed-task activity tests.

## Follow-up: Delegate session activity

Delegate sessions (`parent_session_id IS NOT NULL`) do not participate in server-side activity tracking. Runtime `agent_start` / `agent_end` activity transitions for delegate sessions are ignored, so delegates are never marked `running` or `finished`. The activity snapshot endpoint remains a raw read of persisted activity state; delegate sessions are naturally absent because they never receive activity. The parent session's activity is the only indicator used while delegated work is in progress.

## Follow-up: Browser sleep / resume reconciliation

A sleeping laptop can miss the terminal `agent_end` WebSocket message without always producing an immediate WebSocket reconnect. AppStore now uses the same server reconciliation path for WebSocket reconnects and browser resume signals (`focus`, `online`, `pageshow`, and visible `visibilitychange`). On resume it refreshes the project list, activity snapshot, loaded project stores, and active session metadata/messages so a stale `isStreaming` flag is cleared from the server-authoritative session state.
