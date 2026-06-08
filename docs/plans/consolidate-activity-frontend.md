# Consolidate Activity State Management in Frontend Stores

## Problem

Activity state was split across three stores with overlapping responsibilities:

- **ProjectStore** had mutation methods with business logic (closed-task guards, REST calls, `applyServerState` during fetches), plus dead code (`reconcileRunningActivity`)
- **ProjectsStore** routed WS events but delegated mutations to ProjectStore (creating stores just to mutate activity)
- **ActivityStore** received mutations from two different code paths (ProjectsStore and ProjectStore)
- **ProjectsStore subscribed to ActivityStore** to bubble notifications — a "write then listen for my own writes" pattern
- Activity for unloaded projects was handled differently than loaded projects

## Changes Made

### `packages/frontend/src/models/stores/projects-store.ts`

**Added methods (all activity mutations now live here):**
- `setRunning(sessionId, projectId)` — with closed-task guard via `peekStore` (no store creation), then `this.notify()`
- `setFinished(sessionId, projectId, options)` — same guard, then `this.notify()`
- `markSessionViewed(projectId, sessionId)` — moved from ProjectStore; optimistic update + REST + rollback, explicit `this.notify()` after each path
- `trackDelegateSession(sessionId)` — moved from ProjectStore, then `this.notify()`
- `applyServerState(sessionId, state, projectId)` — public wrapper for snapshot, then `this.notify()`
- `clearActivityForClosedTasks(projectId?)` — consolidated to collect IDs from loaded stores and clear on ActivityStore, then `this.notify()`

**Refactored methods:**
- `handleAgentStart()` → calls `this.setRunning()` (no longer creates ProjectStore)
- `handleAgentEnd()` → calls `this.setFinished()` (no longer creates ProjectStore)
- `handleSessionCreated()` → calls `this.trackDelegateSession()` instead of `projectStore?.trackDelegateSession()`
- `handleTaskUpdated()` → calls `this.clearActivityForClosedTasks(projectId)` instead of `projectStore.clearActivityForClosedTasks()`
- `refresh()` / `ensureLoaded()` → call `this.clearActivityForClosedTasks(projectId)` after fetch

**Removed:**
- Constructor subscription `this._activity.subscribe(() => this.notify())` — replaced with explicit `this.notify()` after each mutation

### `packages/frontend/src/models/stores/project-store.ts`

**Removed methods:**
- `markSessionRunning()`, `markSessionFinished()`, `markSessionViewed()`, `reconcileRunningActivity()` (dead code), `trackDelegateSession()`, `clearActivityForClosedTasks()`
- `fetchSession()` (private) — only used by removed `reconcileRunningActivity()`

**Removed behavior:**
- `applyServerState()` calls from `fetchLists()` and `fetchTaskSessions()` — activity is managed entirely by snapshot + WS events
- `clearActivityForClosedTasks()` call from end of `fetchLists()` — handled by caller
- Subscription to ActivityStore in constructor — UI updates flow through AppStore → app.ts re-render → property update
- `_unsubActivity` field and cleanup in `dispose()`

**Added:**
- `activityStore` getter — exposes the ActivityStore reference (for testing and direct reads)

**Kept (read-only selectors):**
- `activityMap`, `activityForSession()`, `activityState`, `tasksWithActivity`, `activitySummary`

### Test Changes

**`project-store.test.ts`:**
- Removed 13 tests for removed mutation methods and `applyServerState` during fetches
- Rewrote "owns project-scoped activity" test to use `activityStore` directly
- Added tests: `activityState` derives running over finished, excludes closed task sessions

**`projects-store.test.ts`:**
- Updated existing tests to use `store.setRunning()` / `store.setFinished()` instead of `store.getStore().markSessionRunning()`
- Updated `activityForSession` test — now works for unloaded projects
- Added 15 new tests for mutations, guards, `markSessionViewed`, `trackDelegateSession`, `clearActivityForClosedTasks`, `handleAgentStart`/`handleAgentEnd` delegation

**`app-store.test.ts`:**
- Updated "routes agent activity events" — `handleAgentStart` no longer creates stores
- Updated "markActiveSessionViewed" — uses `store.projectsStore.setRunning()` / `setFinished()`

## Activity Data Flow After

```
On connect/reconnect:
  └─ fetchActivitySnapshot() → applyServerState() for all sessions → notify()

During operation:
  └─ WS agent_start → handleAgentStart() → setRunning() → notify()
  └─ WS agent_end  → handleAgentEnd()  → setFinished() → notify()
  └─ WS session_updated → refresh() → fetchLists() → notify() (session data, not activity)

User actions:
  └─ markSessionViewed() → optimistic update → notify() → REST → rollback if needed → notify()
```

UI updates flow: ProjectsStore mutation → `this.notify()` → AppStore → app.ts re-render → Lit property update → components re-render.
