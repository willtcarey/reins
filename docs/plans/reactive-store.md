# Reactive Store

## Problem

The frontend has two data channels — WebSocket (agent events, task_updated) and HTTP fetch (task lists, session lists, session data, diffs, spread) — and the orchestration between them is scattered across components. `app.ts` listens to WS events and calls `store.refreshLists()`, `session-sidebar.ts` calls store actions and `refreshLists()` after task creation, `task-list.ts` fetches its own session sublists, `diff-panel.ts` manages polling lifecycle, and `project-sidebar.ts` fetches the project list independently. Views know too much about when and how to fetch.

## Goal

A single reactive store layer that:

1. **Owns all server communication** — WS event handling, HTTP fetching, polling, and invalidation logic live in the store, not in views.
2. **Exposes a read-only reactive surface** — Views subscribe to state slices and render. No `refreshLists()` calls from views or event handlers in `app.ts`.
3. **Reacts to WS events internally** — When a `task_updated` or `agent_end` arrives, the store decides what to refetch. Views don't participate in that decision.
4. **Consolidates fetch-then-notify** — All fetches go through the store, which notifies subscribers once. No ad-hoc `fetch()` calls in leaf components.

## Current data flow

```
                    ┌──────────────────────────────────────────────┐
                    │                  app.ts                       │
                    │  - listens to WS events                      │
                    │  - calls projectStore.refreshLists()          │
                    │  - calls diffStore.refresh()                  │
                    │  - manages activityTracker                    │
                    └──────┬──────────────┬───────────────┬────────┘
                           │              │               │
              ┌────────────▼──┐   ┌───────▼───────┐  ┌───▼──────────┐
              │ ProjectStore   │   │  DiffStore     │  │ ActivityTracker│
              │ - tasks        │   │  - fileData    │  │ - running     │
              │ - sessions     │   │  - fullData    │  │ - finished    │
              │ - sessionData  │   │  - spread      │  └───────────────┘
              │ - fetches via  │   │  - polls /diff │
              │   HTTP         │   │  - polls spread│
              └───────┬────────┘   └───────┬────────┘
                      │                    │
         ┌────────────▼─────┐    ┌─────────▼────────┐
         │ session-sidebar   │    │ diff-panel        │
         │ - calls store     │    │ - reads DiffStore │
         │   actions         │    │                   │
         │ - reads store     │    │                   │
         │   state           │    │                   │
         └──────┬────────────┘    └──────────────────┘
                │
    ┌───────────▼─────────┐
    │ task-list             │
    │ - fetches task        │
    │   sessions itself     │
    └───────────┬─────────┘
                │
    ┌───────────▼─────────┐
    │ project-sidebar       │
    │ - fetches project     │
    │   list itself         │
    └─────────────────────┘
```

Problems:
- **app.ts is a switchboard** — it wires WS events to store methods, manages timers, and coordinates between stores. Business logic leaks into the shell.
- **Views trigger fetches** — `task-list` fetches its own task sessions, `project-sidebar` fetches the project list, `session-sidebar` calls `refreshLists()` after task creation.
- **Duplicate invalidation** — `agent_end` triggers both `refreshLists()` (from app.ts) and `diffStore.refresh()` (from app.ts), with `setTimeout` delays to wait for the backend.
- **Reconnect is a blunt hammer** — on WS reconnect, `refreshSession()` re-fetches the entire session. There's no way to know what was missed.

## Proposed data flow

```
                    ┌──────────────────────────────────────────────┐
                    │                  app.ts                       │
                    │  - creates AppStore                           │
                    │  - connects WS client                        │
                    │  - applies routes                             │
                    │  - passes store to views (read-only)          │
                    └──────────────────┬───────────────────────────┘
                                       │
                           ┌───────────▼───────────┐
                           │       AppStore         │
                           │  - owns WS listener    │
                           │  - owns all fetching   │
                           │  - owns polling/timers  │
                           │  - owns activity state  │
                           │  - owns DiffStore       │
                           │                        │
                           │  State:                │
                           │  - projects            │
                           │  - tasks + taskSessions│
                           │  - sessions            │
                           │  - sessionData         │
                           │  - activity            │
                           │  - connection status   │
                           │                        │
                           │  Sub-store:            │
                           │  - diffStore (diff,    │
                           │    spread, sync)       │
                           └───────────┬────────────┘
                                       │ subscribe()
                    ┌──────────┬───────┴───────┬──────────┐
                    ▼          ▼               ▼          ▼
             session-sidebar  chat-panel   diff-panel  project-sidebar
             (reads state,    (reads state, (reads state,
              dispatches       sends cmds)   reads state)
              intents)
```

## Design

### AppStore owns DiffStore as a sub-store

AppStore is the merger of ProjectStore and ActivityTracker, with DiffStore kept as a separate class that AppStore owns and coordinates. DiffStore has substantial self-contained complexity (polling timers, spread polling, sync actions, syntax highlighting, context lines, diff modes — 426 lines) that doesn't belong in a monolith. ActivityTracker is small (85 lines) and is pure derived state from WS events, so it merges directly into AppStore.

AppStore handles the cross-cutting concerns that currently live in app.ts:
- `agent_end` → call `diffStore.refresh()`
- Session/task changes → recompute branch → call `diffStore.setBranch()`
- Project changes → call `diffStore.setProject()`

Views access DiffStore through AppStore (e.g., `store.diffStore`) but only as a read-only surface. All mutation triggers flow through AppStore internally.

### Internal WS handling

AppStore takes the `AppClient` at construction and subscribes to events internally. When a `task_updated` event arrives, the store refetches the task list — no involvement from app.ts or views.

```ts
class AppStore {
  constructor(client: AppClient) {
    client.onEvent((sessionId, event) => {
      // all event→refetch logic lives here
    });
    client.onConnection((connected) => {
      // reconnect→refetch logic lives here
    });
  }
}
```

### Views dispatch intents, not actions

Views don't call `store.createSession()` or `store.refreshLists()`. They dispatch intent events (which they mostly already do — `new-session`, `delete-task`, etc.) and the store or a thin coordination layer handles them. This keeps views as pure renderers.

### Absorb standalone fetchers

- **project-sidebar** stops fetching `/api/projects` directly. The store owns the project list.
- **task-list** stops fetching `/api/projects/:id/tasks/:id/sessions` directly. Task session sublists live in the store.
- **task-form** stops fetching `/api/projects/:id/tasks/generate` directly. Task creation goes through the store.

### Absorb ActivityTracker

Activity state (running/finished per session) becomes internal state in AppStore. The `setRunning` / `setFinished` / `clear` logic moves into the WS event handler. Views read activity state from the same subscription surface as everything else.

### Diff branch resolution

Currently app.ts bridges session data to DiffStore via `updateDiffBranch()`. In AppStore this becomes an internal dependency — a private method called after `fetchSession()` and `fetchLists()` complete:

```ts
private updateDiffBranch() {
  const session = this.sessionData;
  if (!session?.task_id) { this.diffStore.setBranch(null); return; }
  const task = this.tasks.find((t) => t.id === session.task_id);
  this.diffStore.setBranch(task?.branch_name ?? null);
}
```

No external wiring needed — the dependency is fully internal to AppStore.

### Invalidation rules (internal to store)

| WS Event | Store Reaction |
|---|---|
| `agent_start` | Mark session running in activity state |
| `agent_end` | Mark session finished, refetch task list, refetch diff files |
| `task_updated` | Refetch task list |
| WS reconnect | Refetch session data, task list, session list |

No `setTimeout` guessing — the backend should ensure data is committed before broadcasting events, so fetches can happen immediately.

### Subscription model

Simple notify-all, same as the current stores. Both ProjectStore and DiffStore already use the `Set<listener>` + `notify()` pattern, and Lit components have efficient dirty-checking in their render cycle. Fine-grained subscriptions (e.g., subscribe to just `tasks`) would add complexity for no measurable benefit with the current component count.

### Polling

Spread and diff file polling stay as-is (timer-based), but the timers live inside DiffStore, which is owned by AppStore. Views don't start or stop polling — DiffStore starts polling when a project is set and stops when it's cleared, same as today.

### No backend event enrichment

WS events stay lean — no rich payloads like including the updated task list in `task_updated`. Reasons:
- Refetch payloads are small JSON over localhost — latency is negligible.
- Enriched events couple the backend event shape to the frontend's view needs.
- The latency concern was the `setTimeout` delays, which are fixed by ensuring the backend commits data before broadcasting events.

## Migration path

This is a refactor, not a rewrite. The stores already hold the right state and do the right fetches — they just need to be consolidated and the trigger points moved inward.

1. ✅ **Create AppStore, move WS event handling in** — AppStore wraps ProjectStore's state and methods, takes the AppClient, and handles events internally. ActivityTracker merges into AppStore. Remove the `client.onEvent` and `client.onConnection` handlers from app.ts.
2. ✅ **AppStore owns DiffStore** — AppStore creates and owns the DiffStore instance. Cross-cutting logic (agent_end → diff refresh, session change → branch update, project change → diff project) moves from app.ts into AppStore.
3. ✅ **Absorb project list** — AppStore owns the project list. project-sidebar reads from the store instead of fetching directly.
4. ✅ **Absorb task session sublists** — AppStore tracks expanded task sessions. task-list reads from the store instead of fetching directly.
5. ✅ **Clean up app.ts** — app.ts becomes a thin shell: create store, create client, wire client into store, apply routes, render.

Each step can be done independently and tested in isolation.

6. **Add frontend architecture dev doc** — Add `docs/dev/frontend-architecture.md` covering the store layer, WS event flow, and how views consume state. Include the proposed data flow diagram.
