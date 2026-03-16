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

Internally, AppStore delegates project/session state management to `ProjectCollectionStore` (a private implementation detail, not accessed by views).

### DiffStore (`stores/diff-store.ts`)

Owned by AppStore. Manages git diff state: file listings, full diffs, commit spread, and diff mode (branch vs. uncommitted). Handles its own polling timers:

- **File polling** — Polls `/diff/files` every 5 seconds when a project is active.
- **Spread polling** — Polls `/diff/spread` every 60 seconds (every 6th file poll cycle).
- **Syntax highlighting** — Moved to `HighlightController` (see [reactive-controllers.md](reactive-controllers.md)). The store is pure data; it notifies subscribers after mutations and the controller handles web worker communication.
- **Per-hunk expansion** — `expandHunk(filePath, hunkIndex, direction)` fetches the full file content on demand (cached per fetch cycle), builds context lines, and inserts them into the hunk. When expansion closes the gap between adjacent hunks, they auto-merge. Scroll position is preserved for upward expansion.

Views access DiffStore through `store.diffStore` as a read-only surface.

### ProjectCollectionStore (`stores/project-collection-store.ts`)

Internal to AppStore — not accessed by views directly. Manages the project list, project CRUD, and lazily-created `ProjectStore` instances that hold per-project task/session data.

### ProjectStore (`stores/project-store.ts`)

One instance per project, lazily created by `ProjectCollectionStore`. Holds task list, session list, task session sublists, and task mutations for a single project.

### QuickOpenStore (`stores/quick-open-store.ts`)

Standalone store owned by the app shell (not by AppStore — it has no WS event dependencies). Manages data for the quick-open palette (`Cmd+K`):

- **Fetches palette items** — Calls `/api/palette` when the overlay opens.
- **Fuzzy filtering** — Pure functions for fuzzy match scoring and item filtering.
- **Recent session tracking** — Persists recently visited session IDs to localStorage for recency-based ordering.

### Subscription model

Both AppStore and DiffStore use a `Set<listener>` + `notify()` pattern. Components subscribe and trigger Lit re-renders on each notification. Fine-grained per-field subscriptions aren't needed — Lit's dirty checking keeps renders efficient.

The preferred pattern is `StoreController` (see [reactive-controllers.md](reactive-controllers.md)), which handles subscribe/unsubscribe lifecycle automatically:

```ts
// Preferred — reactive controller handles lifecycle
private _storeCtrl = new StoreController<DiffStore>(this);

@property({ attribute: false })
set store(s: DiffStore | null) { this._storeCtrl.store = s; }
get store(): DiffStore | null { return this._storeCtrl.store; }
```

For top-level components that manage the store subscription manually (e.g. `diff-panel` which also has custom `_onStoreUpdate` logic), the manual pattern is still fine:

```ts
// Manual — when you need custom logic on each notification
connectedCallback() {
  this._unsub = this.store.subscribe(() => {
    this._onStoreUpdate();
    this.requestUpdate();
  });
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

Hash-based routing with a single pattern:

- `#/session/:sessionId` — View a specific session
- (empty hash) — No session selected, show empty state

`app.ts` listens for `hashchange`, parses the route, and calls `store.setRoute()`. The store fetches the session data (which includes `project_id`) and derives the active project from it.

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
├── quick-open               — Cmd+K fuzzy search across all sessions
└── branch-indicator         — current branch display
```

### Sidebar layout

The sidebar shows all projects simultaneously as collapsible sections. Each expanded project contains an assistant row and a tasks section. The visual hierarchy uses indentation and a left accent border to group project contents.

```
▶ 📁 Acme API
▶ 📁 Dashboard
▼ 📁 Mobile App               ⋮
┃  💬 Assistant                ⋮  ← popover: "New conversation" + previous sessions
┃  TASKS                       +  ← inline new-task button
┃  ▶ Refactor auth flow        ⋮
┃  ▶ COMPLETED TASKS (3)
▶ 📁 Shared Libs
▼ 📁 Web Frontend             ⋮
┃  💬 Assistant                ⋮
┃  TASKS                       +
┃  ▶ Add dark mode support
┃  ▶ Fix pagination bug
┃  ▶ COMPLETED TASKS (12)
▶ 📁 Workers
[+ Add Project]
```

Key design decisions:

- **Left accent border** (`border-l-2`) on expanded content groups children visually without adding vertical space.
- **Project headers are `text-sm font-medium`**, larger than child items (`text-xs`), creating natural hierarchy.
- **Assistant row** is a plain clickable row, not a button. Previous conversations are tucked into its ⋮ popover menu.
- **"+ New Task"** is an inline icon button on the TASKS header, not a standalone row.
- **Projects auto-expand** when they're the active project or have running sessions.

### Reactive Controllers

Per-component state and behavior (collapse toggles, markdown preview, clipboard confirmation, etc.) should be extracted into [Reactive Controllers](reactive-controllers.md) rather than accumulated as `@state()` properties and private methods on the component. This keeps components thin and makes the logic testable with bun:test using a fake host. See [reactive-controllers.md](reactive-controllers.md) for the full pattern, testing approach, and migration guide.

### View conventions

- **Read from store, don't fetch** — Views receive the store (or store state) as Lit properties and render from it. No direct `fetch()` calls.
- **Dispatch intents via events** — Views emit custom events (`new-session`, `delete-task`, etc.) for actions. The parent component or store handles the intent.
- **No WS event handling** — Views never listen to WebSocket events. All event→refetch logic is internal to AppStore.

## Changes subsystem (`changes/`)

The diff/changes feature has its own directory with several supporting modules:

- `diff-panel.ts` — Layout shell: branch header, scroll container, file tree sidebar. Owns state coordination (collapsed files, markdown cache, expand-hunk loading keys) and wires child events to the DiffStore.
- `diff-file-card.ts` — Per-file card: collapsible header with copy/download actions, delegates to `<diff-hunk>` and `<diff-markdown-preview>`.
- `diff-hunk.ts` — Single hunk: separator/expand-up button, hunk header, diff lines, trailer/expand-down button.
- `diff-markdown-preview.ts` — Markdown Diff/Preview tab bar and rendered content area.
- `diff-file-tree.ts` — Collapsible file tree with scroll spy integration
- `file-tree-state.ts` — UI-local state for tree expansion (not in store — ephemeral)
- `scroll-spy.ts` — Tracks which diff card is visible for tree highlighting
- `highlighter.ts` — Manages syntax highlighting via Web Worker. Exports `IHighlighter` interface for test fakes.
- `highlight-worker.ts` — Web Worker for off-main-thread Shiki highlighting
- `diff-sort.ts` — Sorting utilities for diff files
- `diff-utils.ts` — Pure helpers (isMarkdown, fileCardId, escapeHtml, gutterWidth, getHunkEndLine)
- `types.ts` — Shared types for diff data structures

`diff-file-card` and `diff-hunk` use `StoreController<DiffStore>` to re-render on store notifications. `diff-panel` owns a `HighlightController` that sends files to the Shiki web worker for syntax highlighting; when results arrive, it mutates `DiffLine.html` in place and triggers a re-render (see [reactive-controllers.md](reactive-controllers.md)).
