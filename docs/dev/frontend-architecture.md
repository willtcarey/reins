# Frontend Architecture

The frontend is a Lit + Tailwind CSS v4 SPA bundled with `bun build`. It communicates with the backend via REST (fetches) and a WebSocket (real-time events and commands).

## Store layer

All server communication — fetching, WebSocket event handling, polling, and invalidation — lives in a centralized store layer. Views read state and render; they never fetch data or decide when to refetch.

```
                    ┌──────────────────────────────────────────────┐
                    │                  app.ts                       │
                    │  - creates AppStore + AppClient               │
                    │  - applies hash-based routes                  │
                    │  - passes store to views (read-only)          │
                    │  - owns UI-local state (active tab, title)    │
                    └──────────────────┬───────────────────────────┘
                                       │
                           ┌───────────▼───────────┐
                           │       AppStore         │
                           │                        │
                           │  State:                │
                           │  - projects            │
                           │  - tasks + taskSessions│
                           │  - sessions            │
                           │  - sessionData         │
                           │  - activity (per-      │
                           │    session running/     │
                           │    finished)            │
                           │  - connection status    │
                           │                        │
                           │  Sub-store:            │
                           │  - diffStore (diff,    │
                           │    spread, polling)     │
                           └───────────┬────────────┘
                                       │ subscribe()
                    ┌──────────┬───────┴───────┬──────────┐
                    ▼          ▼               ▼          ▼
             session-sidebar  chat-panel   diff-panel  project-sidebar
```

### AppStore (`stores/app-store.ts`)

The central store. Constructed with an `AppClient` (WebSocket client) and internally subscribes to connection and event callbacks. Responsibilities:

- **Owns all HTTP fetches** — projects, tasks, sessions, session data, task generation, project CRUD. No component calls `fetch()` directly.
- **Handles WS events internally** — `agent_start` / `agent_end` update activity state and trigger refetches. `task_updated` refreshes the task list. `tool_execution_end` for file-modifying tools refreshes the diff. Views don't participate in these decisions.
- **Manages reconnect** — On WebSocket reconnect, refetches the project list and active session data to catch up on missed events.
- **Coordinates sub-stores** — When the session or project changes, AppStore updates DiffStore's branch and project. When an agent completes, AppStore tells DiffStore to refresh.
- **Tracks activity** — Per-session running/finished state (absorbed from the former ActivityTracker). Used for title badge counts and sidebar indicators.

Internally, AppStore delegates project/session state management to `ProjectStore` (a private implementation detail, not accessed by views).

### DiffStore (`stores/diff-store.ts`)

Owned by AppStore. Manages git diff state: file listings, full syntax-highlighted diffs, commit spread, and diff mode (branch vs. uncommitted). Handles its own polling timers:

- **File polling** — Polls `/diff/files` every 5 seconds when a project is active.
- **Spread polling** — Polls `/diff/spread` every 60 seconds (every 6th file poll cycle).
- **Syntax highlighting** — Uses a Web Worker (`highlight-worker.ts`) for off-main-thread highlighting.

Views access DiffStore through `store.diffStore` as a read-only surface.

### ProjectStore (`stores/project-store.ts`)

Internal to AppStore — not accessed by views directly. Manages the active project's task list, session list, and active session data. Handles route resolution (project ID + session ID → fetch and populate state).

### Subscription model

Both AppStore and DiffStore use a `Set<listener>` + `notify()` pattern. Components subscribe in `connectedCallback` and bump a `@state()` version counter to trigger Lit's re-render cycle. Fine-grained per-field subscriptions aren't needed — Lit's dirty checking keeps renders efficient.

```ts
// Typical component pattern
@state() private _storeVersion = 0;

connectedCallback() {
  this._unsub = this.store.subscribe(() => this._storeVersion++);
}
```

## WebSocket client (`ws-client.ts`)

Thin WebSocket wrapper. Two roles:

1. **Receives** — All active session events, each tagged with a `sessionId`. Events include `agent_start`, `agent_end`, `tool_execution_end`, `task_updated`, streaming tokens, etc.
2. **Sends** — Commands (`prompt`, `steer`, `abort`) with an explicit `sessionId`.

The client provides `onConnection(cb)` and `onEvent(cb)` hooks. AppStore is the sole consumer of these hooks — no other code listens to WS events.

## WS event → store reaction

| WS Event | Store Reaction |
|---|---|
| `agent_start` | Mark session running in activity state |
| `agent_end` | Mark session finished, refetch task list, refresh diff |
| `task_updated` | Refetch task list |
| `tool_execution_end` (file-modifying) | Refresh diff |
| WS reconnect | Refetch project list, refetch active session data |

## Routing (`router.ts`)

Hash-based routing with two patterns:

- `#/project/:id` — Select project, resolve to most recent session
- `#/project/:id/session/:sessionId` — Select specific session

`app.ts` listens for `hashchange`, parses the route, and calls `store.setRoute()`. The store handles all fetching and state updates. If the route needs to resolve to a specific session (e.g., bare project URL), the store returns a `navigateTo` hint and `app.ts` updates the hash.

## Component structure

```
app-shell                    — root shell, creates store, applies routes
├── session-sidebar          — project list, task list, session list
│   ├── project-sidebar      — project selector + CRUD
│   ├── task-list            — tasks with expandable session sublists
│   ├── task-form            — task creation (generate from prompt)
│   ├── task-detail          — task edit/delete
│   └── session-list         — scratch sessions
├── chat-panel               — message display + input
│   └── diff-file-tree       — file tree sidebar (wide screens)
├── diff-panel               — full diff view with file cards
│   └── diff-file-tree       — file tree with scroll spy
└── branch-indicator         — current branch display
```

### View conventions

- **Read from store, don't fetch** — Views receive the store (or store state) as Lit properties and render from it. No direct `fetch()` calls.
- **Dispatch intents via events** — Views emit custom events (`new-session`, `delete-task`, etc.) for actions. The parent component or store handles the intent.
- **No WS event handling** — Views never listen to WebSocket events. All event→refetch logic is internal to AppStore.

## Changes subsystem (`changes/`)

The diff/changes feature has its own directory with several supporting modules:

- `diff-panel.ts` — Main diff view, renders file cards with highlighted diffs
- `diff-file-tree.ts` — Collapsible file tree with scroll spy integration
- `file-tree-state.ts` — UI-local state for tree expansion (not in store — ephemeral)
- `scroll-spy.ts` — Tracks which diff card is visible for tree highlighting
- `highlighter.ts` — Manages syntax highlighting via Web Worker
- `highlight-worker.ts` — Web Worker for off-main-thread highlighting
- `diff-sort.ts` — Sorting utilities for diff files
- `types.ts` — Shared types for diff data structures
