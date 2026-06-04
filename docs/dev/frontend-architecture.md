# Frontend Architecture

The frontend is a Lit + Tailwind CSS v4 SPA bundled with `bun build`. It communicates with the backend via REST (fetches) and a WebSocket (real-time events and commands).

## Source Organization

```
src/
├── models/          Pure logic — no LitElement, no html``
├── components/      Lit components — rendering + interaction
├── controllers/     Lit reactive controllers (glue between models + components)
├── __tests__/       Tests mirroring app structure
└── index.ts         Entry point
```

**Dependency rule:** `models/` never imports from `components/` or `controllers/`. Everything else can import from `models/`.

```
  components/  ──→  models/  ←──  controllers/
       │                               │
       └──────→  controllers/  ←───────┘
```

### models/

Pure TypeScript with no Lit dependency. Contains all business logic, state management, data extraction, and server communication. Everything here is directly testable with bun:test — no DOM, no browser.

```
models/
├── stores/              Shared state management (pubsub)
│   ├── app-store.ts
│   ├── active-session-store.ts
│   ├── activity-store.ts
│   ├── diff-store.ts
│   ├── project-store.ts
│   ├── projects-store.ts
│   ├── file-browser-store.ts
│   ├── quick-open-store.ts
│   └── settings-store.ts
├── changes/             Diff/highlighting pure logic
│   ├── diff-sort.ts, diff-utils.ts, file-tree-state.ts
│   ├── highlighter.ts, highlight-worker.ts, scroll-spy.ts
│   └── types.ts
├── tools/               Tool data extraction helpers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   └── bash-command-parser.ts
├── tasks.ts             Task list types and TasksCollection model
├── chat-state.ts        Chat event reducer
├── format.ts            Display formatting helpers
├── router.ts            Hash-based route parsing
└── ws-client.ts         WebSocket client
```

### components/

Lit custom elements that own rendering and user interaction. Import from `models/` for data, from `controllers/` for lifecycle-managed behavior.

```
components/
├── changes/             Diff viewer components
│   ├── diff-panel.ts, diff-file-card.ts, diff-file-tree.ts
│   ├── diff-hunk.ts, diff-markdown-preview.ts
├── tools/               Tool-specific chat renderers
│   ├── read.ts, edit.ts, write.ts, bash.ts
│   ├── create-task.ts, delegate.ts, generic.ts
│   ├── index.ts (registry), types.ts
├── app.ts               Root shell
├── chat-panel.ts        Message display + composer orchestration
├── chat-composer.ts     Prompt input, autosize, skill suggestions, image attachments
├── session-sidebar.ts   Sidebar layout
├── session-list.ts, project-sidebar.ts, project-form.ts
├── task-list.ts, task-detail.ts, task-form.ts
├── branch-indicator.ts, quick-open.ts, search-palette.ts
├── file-browser.ts, file-search.ts, file-viewer.ts
├── popover-menu.ts, toast.ts
└── app.css
```

When splitting or moving components, prefer the new canonical path immediately. Do **not** leave thin compatibility wrapper modules that only re-export from the new location. Update imports at call sites instead — wrapper files add indirection and make the component layout harder to navigate.

### controllers/

Lit reactive controllers — lifecycle-managed glue reused across components. See [reactive-controllers.md](reactive-controllers.md).

```
controllers/
├── store-controller.ts          Generic store subscription
├── highlight-controller.ts      Shiki web worker bridge
└── lazy-highlight-controller.ts IntersectionObserver + highlighting
```

## Data Flow

The overall data flow is one-directional:

```
  Server (REST + WS)
         │
         ▼
  models/stores/     ← owns all fetches, WS events, polling
         │
         │ subscribe()
         ▼
  controllers/       ← lifecycle glue (StoreController, HighlightController)
         │
         │ host.requestUpdate()
         ▼
  components/        ← render from store state, dispatch intents via events
         │
         │ custom events (new-session, delete-task, etc.)
         ▼
  models/stores/     ← handles intents, triggers fetches
```

Views never call `fetch()` directly or listen to WebSocket events. All server communication and event→refetch logic is internal to the stores.

## Store layer

All server communication — fetching, WebSocket event handling, polling, and invalidation — lives in a centralized store layer. Views read state and render; they never fetch data or decide when to refetch.

```
                    ┌──────────────────────────────────────────────┐
                    │              components/app.ts                │
                    │  - creates AppStore + AppClient               │
                    │  - applies hash-based routes                  │
                    │  - passes store to views (read-only)          │
                    │  - owns UI-local state (active tab, title)    │
                    └──────────────────┬───────────────────────────┘
                                       │
                           ┌───────────▼───────────┐
                           │       AppStore         │
                           │   (models/stores/)     │
                           │                        │
                           │  State:                │
                           │  - projects            │
                           │  - tasks + taskSessions│
                           │  - sessions            │
                           │  - sessionData         │
                           │  - sessionMessages     │
                           │  - connection status    │
                           │                        │
                           │  Sub-stores:           │
                           │  - diffStore (diff,    │
                           │    spread, polling)     │
                           │  - project stores       │
                           │    (tasks/sessions +    │
                           │    activity selectors)  │
                           └───────────┬────────────┘
                                       │ subscribe()
                    ┌──────────┬───────┴───────┬──────────┐
                    ▼          ▼               ▼          ▼
             session-sidebar  chat-panel   diff-panel  project-sidebar
                              (components/)
```

### AppStore (`models/stores/app-store.ts`)

The central store. Constructed with an `AppClient` (WebSocket client) and internally subscribes to connection and event callbacks. Responsibilities:

- **Owns server communication boundaries** — AppStore and its sub-stores perform REST/WS work; components do not call `fetch()` directly.
- **Handles WS events internally** — `agent_start` / `agent_end` update activity state and trigger refetches. `task_updated` refreshes the task list and clears activity for sessions on closed tasks. `session_updated` refreshes the active session and project lists. `tool_execution_end` for file-modifying tools refreshes the diff. Views don't participate in these decisions.
- **Manages reconnect** — On WebSocket reconnect, refetches the project list, refreshes loaded project stores, refreshes active session metadata/messages, and reconciles locally-running activity against backend session streaming state to catch up on missed events.
- **Splits active session state** — Session metadata (`sessionData`) and persisted history (`sessionMessages`) are fetched separately so metadata refreshes can't clobber in-flight chat rendering.
- **Uses blank session metadata while loading** — `ActiveSessionStore` keeps `sessionData` as a placeholder object for the active `sessionId` until the metadata request completes, so views don't need null checks for the selected session.
- **Exposes the active session store directly to the chat view** — `chat-panel` receives `ActiveSessionStore`, reads `sessionData` / `sessionMessages` from it, and sends prompt/steer/abort/model-update intents back through the same store.
- **Coordinates sub-stores** — When the session or project changes, AppStore updates DiffStore's branch and project. When an agent completes, AppStore tells DiffStore to refresh.
- **Routes activity events** — WS events are dispatched by `projectId` to `ProjectsStore`, which owns cross-project activity event helpers. AppStore does not mutate raw activity state directly.

AppStore exposes `projectsStore` as the public project-domain sub-store for sidebar/project UI. Components should prefer semantic AppStore/ProjectsStore methods over reaching into lower-level store internals.

### DiffStore (`models/stores/diff-store.ts`)

Owned by AppStore. Manages git diff state: file listings, full diffs, commit spread, and diff mode (branch vs. uncommitted). Handles its own polling timers:

- **File polling** — Polls `/diff/files` every 5 seconds when a project is active.
- **Spread polling** — Polls `/diff/spread` every 60 seconds (every 6th file poll cycle).
- **Syntax highlighting** — Moved to `HighlightController` (see [reactive-controllers.md](reactive-controllers.md)). The store is pure data; it notifies subscribers after mutations and the controller handles web worker communication.
- **Per-hunk expansion** — `expandHunk(filePath, hunkIndex, direction)` fetches the full file content on demand (cached per fetch cycle), builds context lines, and inserts them into the hunk. When expansion closes the gap between adjacent hunks, they auto-merge. Scroll position is preserved for upward expansion.

Views access DiffStore through `store.diffStore` as a read-only surface.

### ProjectsStore (`models/stores/projects-store.ts`)

Public AppStore sub-store for project-domain UI. Manages the project list, project CRUD, lazily-created `ProjectStore` instances, cross-project activity selectors/event helpers, and project-domain reconnect catch-up. Sidebar and quick-open may read this store directly for project concerns: `activityForProject(projectId)` for project header dots, `activityForSession(projectId, sessionId)` for session indicators, and `activitySummary` for shell-level badge counts.

### ProjectStore (`models/stores/project-store.ts`)

One instance per project, lazily created by `ProjectsStore`. Holds a data-only `TasksCollection`, session list, task session sublists, task mutations, and one private project-scoped `ActivityStore`. It exposes semantic activity methods/selectors (`markSessionRunning`, `markSessionFinished`, `markSessionViewed`, `activityForSession`, `tasksWithActivity`, `activityMap`, and `activityState`) so callers do not reach into raw activity internals. Task/list fetches clear activity for sessions on closed tasks, and reconnect reconciliation fetches session detail for locally-running sessions in this project.

### ActivityStore (`models/stores/activity-store.ts`)

Owned by `ProjectStore`. Manages raw per-session notification state (`sessionId → running | finished`), delegate-session tracking, viewed/cleared transitions, and the set of locally-running session ids for one project. It does not know about project ids, project collections, or task data; `ProjectStore` is responsible for combining raw activity with task/session state and for closed-task/reconnect cleanup.

### QuickOpenStore (`models/stores/quick-open-store.ts`)

Standalone store owned by the app shell (not by AppStore — it has no WS event dependencies). Manages data for the quick-open palette (`Cmd+K`):

- **Fetches palette items** — Calls `/api/palette` when the overlay opens.
- **Fuzzy filtering** — Pure functions for fuzzy match scoring and item filtering.
- **Recent session tracking** — Persists recently visited session IDs to localStorage for recency-based ordering.

### FileBrowserStore (`models/stores/file-browser-store.ts`)

Standalone store for the file browser overlay. Manages:

- **File list** — Fetches project files via `GET /api/projects/:id/files` (git-tracked + untracked non-ignored), cached per project.
- **Fuzzy filtering** — Reuses `fuzzyMatch` from `quick-open-store.ts` for file search.
- **File content** — Loads file content via `GET /api/projects/:id/file?path=...` for the viewer.

Shared by `<file-search>` (palette) and `<file-browser>` (viewer overlay). Both components and `<app-shell>` hold a reference to the same store instance.

### ModelRegistryStore (`models/stores/model-registry-store.ts`)

Standalone store for the shared `/api/models` registry. Manages:

- **Provider/model loading** — Fetches the provider registry, including key availability and model metadata.
- **Derived registry helpers** — Exposes configured/unconfigured providers, API-key badges, and provider/model lookup helpers for UI components.
- **Shared model metadata** — Keeps model naming and option lists decoupled from settings form state.

Used by `<settings-panel>` and `<session-model-picker>` so both flows read from the same dedicated registry boundary.

### SettingsStore (`models/stores/settings-store.ts`)

Standalone store for persisted settings and auth-related mutations. Manages:

- **Settings fetches** — Loads OAuth providers and only the requested setting keys via the batched `/api/settings?key=...` endpoint.
- **Settings mutations** — Saves/removes API keys, starts/completes OAuth flows, and updates model settings.
- **Panel state boundary** — Holds stored settings state and async action flags; the component keeps only overlay visibility and ephemeral input values.

Used alongside `ModelRegistryStore` via `StoreController` so the view renders from store state instead of calling `fetch()` directly.

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

## WebSocket client (`models/ws-client.ts`)

Thin WebSocket wrapper. Two roles:

1. **Receives** — All active session events, each tagged with a `sessionId`. Events include `agent_start`, `agent_end`, `tool_execution_end`, `task_updated`, `session_updated`, streaming tokens, etc.
2. **Sends** — Commands (`prompt`, `steer`, `abort`) with an explicit `sessionId`.

The client provides `onConnection(cb)` and `onEvent(cb)` hooks. AppStore is the sole consumer of these hooks — no other code listens to WS events.

## WS event → store reaction

| WS Event | Store Reaction |
|---|---|
| `agent_start` | Route to the event project's activity store and mark the session running |
| `agent_end` | Route to `ProjectsStore.handleAgentEnd`; mark open sessions finished unless `suppressUnread` is set; clear delegate/closed-task sessions; refetch task list; refresh diff |
| `task_updated` | Refetch that project store if it exists and clear activity for sessions on closed tasks |
| `session_updated` | Refetch the active session (if selected) and refresh project lists |
| `tool_execution_end` (file-modifying) | Refresh diff |
| WS reconnect | Refetch project list, refresh loaded project stores, refetch active session data/messages, reconcile locally-running activity against `/api/sessions/:id` streaming state |

### Activity indicator semantics

Raw session activity is owned by each `ProjectStore`'s private `ActivityStore` (`sessionId → running | finished`), and the `ActivityState` type is exported from `activity-store.ts`. Task list types and the project-scoped `TasksCollection` model live in `models/tasks.ts`. `ProjectStore` holds a data-only `TasksCollection`, combines it with raw activity via `tasksWithActivity`, and exposes project activity (`activityState`). `ProjectsStore` offers `activityForProject(projectId)`, `activityForSession(projectId, sessionId)`, and `activitySummary` instead of building a global session activity map. AppStore delegates title/sidebar badge counts to `ProjectsStore.activitySummary`.

Running indicators are green and remain visible while the agent loop is active, even if the user views that session. Finished indicators are amber, represent unread completed work, and are cleared when the session is viewed.

Closed task sessions do not keep activity notifications. When task data is refreshed after `task_updated` or reconnect, `ProjectStore` removes both running and finished activity for sessions on closed tasks. Task selectors also suppress indicators for closed tasks.

Reconnect reconciliation only touches sessions already marked locally `running`: still-streaming backend sessions stay green, deleted sessions clear, ended active sessions clear, and ended background sessions become `finished` unread activity.

Known follow-up areas:

- Activity state is in-memory only. A full page reload starts with no unread indicators; restoring running indicators from session metadata (`state.isStreaming`) across loaded session lists would require a separate reconciliation pass.
- `task_updated` broadcasts do not identify which task changed, so closed-task cleanup has to refetch project task data before pruning finished activity. Including changed task/session identifiers in the broadcast would make this more targeted.

## Routing (`models/router.ts`)

Hash-based routing with a single pattern:

- `#/session/:sessionId` — View a specific session
- (empty hash) — No session selected, show empty state

`components/app.ts` listens for `hashchange`, parses the route, and calls `store.setRoute()`. The store fetches the session data (which includes `project_id`) and derives the active project from it. The chat panel is rendered with `keyed(store.sessionId, ...)` so switching sessions remounts the component and clears any per-session ephemeral UI state.

### Last-viewed hash restore

The router module provides `getLastHash()` and `saveHash()` helpers backed by `localStorage` (`reins:last-hash` key). `app.ts` saves `location.hash` on every `hashchange` event, and restores it on fresh page loads when no hash route is present. This is a pure routing concern — the store layer is not involved. If a stored hash points to a deleted session, the normal fetch-404 handling shows the empty state.

## Component structure

```
app-shell                    — root shell, creates store, applies routes
├── session-sidebar          — project list, task list, session list
│   ├── project-sidebar      — project selector + CRUD
│   ├── task-list            — tasks with expandable session sublists
│   ├── task-form            — task creation (generate from prompt)
│   ├── task-detail          — task edit/delete
│   └── session-list         — scratch sessions
├── chat-panel               — message display + composer orchestration
│   ├── chat-composer        — prompt input, autosize, skill suggestions, image attachments
│   └── diff-file-tree       — file tree sidebar (wide screens)
├── diff-panel               — full diff view with file cards
│   └── diff-file-tree       — file tree with scroll spy
├── quick-open               — Cmd+K fuzzy search across all sessions
├── file-search              — Cmd+P fuzzy file search (uses search-palette)
├── file-browser             — file viewer overlay shell
│   └── file-viewer          — syntax-highlighted read-only file content
└── branch-indicator         — current branch display
```

All components live under `components/`. Sub-directories (`changes/`, `tools/`) group related components.

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
- **Pass callbacks for action-only dependencies** — If a child only needs to trigger an action and does not subscribe to or render from store state, pass a narrow callback like `onSave` / `updateSessionModel` instead of the whole store.
- **Dispatch intents via events** — Views emit custom events (`new-session`, `delete-task`, etc.) for actions. The parent component or store handles the intent.
- **No WS event handling** — Views never listen to WebSocket events. All event→refetch logic is internal to AppStore.

## Tool renderers (`components/tools/`)

Tool calls in the chat panel are rendered by tool-specific renderers rather than a generic JSON dump. Each tool (read, bash, edit, write, create_task, delegate) has a dedicated component in `components/tools/` that owns its full visual output. Pure data-extraction helpers live in `models/tools/`. A registry in `components/tools/index.ts` maps tool names to renderers, falling back to a generic renderer for unknown tools.

`components/chat-panel.ts`'s `renderToolBlock()` is a thin 5-line dispatcher that looks up the renderer and calls `render()`.

See [tool-renderers.md](tool-renderers.md) for the full architecture, rendering tiers, and how to add new renderers.

## Changes subsystem

The diff/changes feature spans both `models/changes/` (pure logic) and `components/changes/` (Lit components):

**Pure logic (`models/changes/`):**
- `diff-sort.ts` — Sorting utilities for diff files
- `diff-utils.ts` — Pure helpers (isMarkdown, fileCardId, escapeHtml, gutterWidth, getHunkEndLine, diffLineKey)
- `file-tree-state.ts` — UI-local state for tree expansion (not in store — ephemeral)
- `scroll-spy.ts` — Tracks which diff card is visible for tree highlighting
- `highlighter.ts` — Pure-function interface to the Shiki Web Worker: text lines in, HTML lines out via callback. Exports `IHighlighter` for test fakes.
- `highlight-worker.ts` — Web Worker for off-main-thread Shiki highlighting
- `types.ts` — Shared types for diff data structures

**Components (`components/changes/`):**
- `diff-panel.ts` — Layout shell: branch header, scroll container, file tree sidebar. Owns state coordination and wires child events to the DiffStore.
- `diff-file-card.ts` — Per-file card: collapsible header with copy/download actions, delegates to `<diff-hunk>` and `<diff-markdown-preview>`.
- `diff-hunk.ts` — Single hunk: separator/expand-up button, hunk header, diff lines, trailer/expand-down button.
- `diff-markdown-preview.ts` — Markdown Diff/Preview tab bar and rendered content area.
- `diff-file-tree.ts` — Collapsible file tree with scroll spy integration

`diff-file-card` and `diff-hunk` use `StoreController<DiffStore>` to re-render on store notifications. Each `<diff-hunk>` owns a `HighlightController` that sends the hunk's text lines to the Shiki web worker for syntax highlighting. The controller stores the resulting HTML strings — the highlighter never mutates `DiffLine` objects. During render, `diff-hunk` reads `controller.getLineHtml(index)` and falls back to escaped plain text if highlighting hasn't completed yet (see [reactive-controllers.md](reactive-controllers.md)).
