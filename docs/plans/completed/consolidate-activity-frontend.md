# Consolidate Activity State Management in Frontend Stores

## Problem

Activity indicators were split across multiple frontend stores and partially inferred from transient runtime WebSocket events. That made behavior inconsistent for unloaded projects, reloads/reconnects, delegate sessions, closed tasks, and active-session viewing.

The server-side persistence work made session metadata (`activityState`) authoritative, so the frontend no longer needed a separate activity domain store with mutation rules that could drift from the backend.

## Final Design

Session activity now lives in the shared `SessionCache` as canonical session metadata:

```ts
type ActivityState = "running" | "finished" | null;
```

Frontend stores derive indicators from cached session rows instead of maintaining a parallel activity map.

## Changes Made

### 1. Added `SessionCache`

**File:** `packages/frontend/src/models/stores/session-cache.ts`

`SessionCache` is the shared keyed cache for canonical session metadata. It is populated by:

- session detail fetches (`GET /api/sessions/:id`)
- project/session list fetches
- task session list fetches
- server-side activity snapshots (`GET /api/sessions/activity`)
- successful metadata edits such as model changes

It supports per-session subscriptions for active-session detail and global subscriptions for project/task/sidebar selectors.

### 2. Removed `ActivityStore`

**File removed:** `packages/frontend/src/models/stores/activity-store.ts`

The frontend no longer owns separate `sessionId -> running | finished` activity state. Removed frontend-only mutation paths including local running/finished transitions, delegate suppression sets, and closed-task pruning logic.

### 3. Refactored `ProjectStore` to derive activity

**File:** `packages/frontend/src/models/stores/project-store.ts`

`ProjectStore` now stores project task rows and session ordering only. Full session metadata is read from `SessionCache`.

Kept read-only selectors:

- `activityForSession(sessionId)`
- `activityForTask(taskId)`
- `activityState`

Removed activity mutation APIs and duplicate session list records. Scratch sessions are derived from cached metadata in server-provided order, and task sessions are derived live from cached project/task metadata.

### 4. Refactored `ProjectsStore` around server snapshots

**File:** `packages/frontend/src/models/stores/projects-store.ts`

`ProjectsStore` owns project-list concerns and cross-project activity selectors:

- `activityForProject(projectId)`
- `activityForSession(projectId, sessionId)`
- `activitySummary`

It fetches `/api/sessions/activity` on reconnect/resume and writes the snapshot into `SessionCache`, clearing any locally cached activity for sessions absent from the snapshot.

Raw `agent_start` / `agent_end` WebSocket events no longer mutate activity directly; they are used for active chat streaming and diff refresh behavior only. Activity changes arrive through backend-persisted session state and `session_updated` reconciliation.

### 5. Refactored `ActiveSessionStore` to use `SessionCache`

**File:** `packages/frontend/src/models/stores/active-session-store.ts`

Active session metadata is derived from `SessionCache`. When the active session receives `activityState: "finished"`, `markViewed()` clears it optimistically in the cache and calls `PATCH /api/sessions/:sessionId/activity` so the server clears unread activity and broadcasts reconciliation.

## Activity Data Flow After

```text
Initial connect / reconnect / browser resume
  -> AppStore.requestServerReconcile()
  -> ProjectsStore.fetchActivitySnapshot()
  -> SessionCache stores active session activity
  -> project/sidebar/task selectors derive dots from SessionCache

Runtime starts/ends
  -> backend persists activity_state
  -> backend broadcasts session_updated
  -> frontend fetches canonical session/list data
  -> SessionCache updates activityState

User views finished active session
  -> ActiveSessionStore.markViewed()
  -> optimistic SessionCache activityState = null
  -> PATCH /api/sessions/:sessionId/activity
  -> backend clears finished activity and broadcasts session_updated
```

## Streaming and Compaction Boundary

Only notification activity is persisted in `activityState`:

- `running` / `finished` dots are server-authoritative session metadata.
- Active chat rendering state (`isStreaming`, streaming blocks, `isCompacting`) remains in `ChatState` and is driven by live runtime events plus active-session metadata reconciliation.
- Compaction messages are persisted as conversation history, but compaction in-progress UI is not modeled as session activity.

## Tests Updated

Tests were updated around the final contracts:

- activity snapshot fetch and cache reconciliation on connect/reconnect
- project/task/session activity selectors deriving from `SessionCache`
- active-session viewed behavior and rollback
- removal of raw `agent_start` / `agent_end` activity mutation expectations
- deleted `ActivityStore` behavior tests
