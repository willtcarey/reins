# Persist Session Activity State Server-Side

## Problem

Session activity indicators (`running` green dot, `finished` amber dot) are maintained entirely in frontend memory via `ActivityStore`. This causes several issues:

- **Full page reload** clears all activity indicators — no unread dots survive.
- **Reconnect after missing both start and end** — if an agent started and finished while disconnected, no indicator appears (reconciliation only checks sessions already marked `running`).
- **Multiple tabs** — each tab has independent activity state with no cross-tab consistency.
- **`activity_viewed_at` is local** — viewing a session in one tab doesn't clear indicators in another tab.

## Current Flow

```
WS agent_start → AppStore → ProjectsStore → ProjectStore → ActivityStore._activityStates.set("running")
WS agent_end   → AppStore → ProjectsStore → ProjectStore → ActivityStore._activityStates.set("finished") or clear
User views     → AppStore → ProjectsStore → ProjectStore → ActivityStore._activityStates.delete()
```

All in-memory, all lost on reload.

Reconnect reconciliation is best-effort: it fetches `/api/sessions/:id` for each locally-`running` session and checks `isStreaming` (a live runtime check). Sessions that started and ended during the disconnect are invisible.

## Solution

Add a single `activity_state` column to the `sessions` table with three values:

| Value | Meaning | UI |
|---|---|---|
| `NULL` | Idle or already viewed — nothing to show | no dot |
| `'running'` | Agent is actively streaming | green dot |
| `'finished'` | Agent ended, user hasn't viewed | amber dot |

### State Transitions

| Trigger | Transition |
|---|---|
| `agent_start` | → `'running'` |
| `agent_end` (user was viewing this session) | → `NULL` |
| `agent_end` (user was NOT viewing) | → `'finished'` |
| user views a `'finished'` session | → `NULL` |

The "viewed" dimension is folded into the state itself — no separate `activity_viewed_at` column. `NULL` means either idle or already viewed, which is indistinguishable from the UI's perspective (no dot either way).

### Server-Side Changes

1. **Migration** — `ALTER TABLE sessions ADD COLUMN activity_state TEXT CHECK(activity_state IN ('running', 'finished'))`
2. **Persistence observer** — update `runtime-persistence-observer.ts` to persist `activity_state` on `agent_start` and `agent_end` events (alongside existing message persistence).
3. **Session list response** — include `activity_state` in session list and session detail responses so the sidebar renders dots on initial load.
4. **REST endpoint** — add `PATCH /api/sessions/:sessionId/activity` (or similar) for the frontend to report "user viewed this session" → transition `finished` → `NULL`.
5. **Broadcast** — broadcast an `activity_updated` event (or piggyback on existing events) so other tabs reconcile immediately.

### Frontend-Side Changes

1. **Read `activity_state` from session data** on initial load — no reconciliation pass needed, the DB is the source of truth.
2. **Keep WS-driven activity updates** for real-time responsiveness — `agent_start`/`agent_end` events still update the local ActivityStore immediately for snappy UI.
3. **On reconnect** — refresh session lists (already done) and let `activity_state` from the DB restore indicators. The reconciliation step (`reconcileRunningActivity`) can be simplified or removed since the server has the authoritative state.
4. **On view** — call the REST endpoint to persist the "viewed" transition server-side.
5. **Multi-tab consistency** — listen for `activity_updated` broadcasts from other tabs' actions.

### What Stays Frontend-Only

- **Streaming UI state** (`isStreaming`, `streamingBlocks`, `isCompacting` in `ChatState`) — these are render concerns, not activity indicators.
- **Real-time dot updates** — WS events still drive immediate UI changes; the DB is the reconciliation source, not the real-time path.

## Migration Details

```sql
ALTER TABLE sessions ADD COLUMN activity_state TEXT CHECK(activity_state IN ('running', 'finished'));
```

No data migration needed — existing rows get `NULL` (idle), which is correct for a fresh start.

## Open Questions

- Should `activity_updated` be a new broadcast type, or can we reuse `session_updated`?
- Does the "user was viewing" check on `agent_end` need to be per-connection (i.e., which WS client had this session selected), or is it sufficient to check if the session ID matches the active session in the runtime persistence observer?
- Should we add a bulk "mark all viewed for project" endpoint for convenience?
