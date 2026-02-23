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
                           │                        │
                           │  State:                │
                           │  - projects            │
                           │  - tasks + taskSessions│
                           │  - sessions            │
                           │  - sessionData         │
                           │  - diff (files, full)  │
                           │  - spread              │
                           │  - activity            │
                           │  - connection status   │
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

### Single store, internal WS handling

The `AppStore` takes the `AppClient` at construction and subscribes to events internally. When a `task_updated` event arrives, the store refetches the task list — no involvement from app.ts or views.

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

### Absorb DiffStore and ActivityTracker

DiffStore and ActivityTracker become internal subsystems of AppStore (or remain separate classes that AppStore owns and coordinates). Views see a single subscription surface.

### Invalidation rules (internal to store)

| WS Event | Store Reaction |
|---|---|
| `agent_start` | Mark session running in activity state |
| `agent_end` | Mark session finished, refetch task list, refetch diff files |
| `task_updated` | Refetch task list |
| WS reconnect | Refetch session data, task list, session list |

No `setTimeout` guessing — the backend should ensure data is committed before broadcasting events, so fetches can happen immediately.

### Polling

Spread and diff file polling stay as-is (timer-based), but the timers live inside the store. Views don't start or stop polling — the store starts polling when a project is set and stops when it's cleared.

## Migration path

This is a refactor, not a rewrite. The stores already hold the right state and do the right fetches — they just need to be consolidated and the trigger points moved inward.

1. **Move WS event handling into ProjectStore** — Remove the `client.onEvent` handler from app.ts. ProjectStore takes the AppClient and handles events internally. ActivityTracker moves into ProjectStore.
2. **Absorb project list** — ProjectStore owns the project list. project-sidebar reads from the store instead of fetching directly.
3. **Absorb task session sublists** — ProjectStore tracks expanded task sessions. task-list reads from the store instead of fetching directly.
4. **Absorb DiffStore** — Either merge into ProjectStore or keep as a sub-store that ProjectStore owns. The key change: diff invalidation on agent_end is triggered internally, not from app.ts.
5. **Clean up app.ts** — app.ts becomes a thin shell: create store, create client, wire client into store, apply routes, render.

Each step can be done independently and tested in isolation.

## Open questions

1. **One store or a coordinated set?** A single `AppStore` is simpler conceptually, but the diff state is complex enough that it may want to stay in its own class, just owned and coordinated by AppStore rather than app.ts.
2. **Subscription granularity** — Currently stores notify on any change and views re-render everything. Fine-grained subscriptions (e.g., subscribe to just `tasks`) would reduce unnecessary renders but add complexity. Worth doing only if performance becomes an issue.
3. **Backend event enrichment** — Should WS events carry richer payloads (e.g., `task_updated` includes the updated task list) to avoid the refetch round-trip? Reduces latency but couples the event shape to the view's needs.
4. **DiffStore coupling** — DiffStore needs the active branch name, which comes from the task list. Currently app.ts bridges this via `updateDiffBranch()`. In the unified store this becomes an internal dependency — when sessionData or tasks change, the diff branch is recomputed automatically.
