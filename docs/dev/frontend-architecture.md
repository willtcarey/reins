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

Pure TypeScript with no Lit dependency. Contains business/domain logic, state management, data extraction, and server communication. Components keep view-local state; anything that decides what data means, when to fetch, how to persist, or how cross-component state changes belongs here. Everything here is directly testable with bun:test — no DOM, no browser.

```
models/
├── stores/              Shared state management (pubsub)
│   ├── app-store.ts
│   ├── active-session-store.ts
│   ├── diff-store.ts
│   ├── conversations-store.ts
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
├── tasks.ts             Task list types
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

Views never call `fetch()` directly or listen to WebSocket events. Stores own business/domain decisions, persisted or server-derived state, async state, and event→refetch logic. Components own presentation and ephemeral interaction state.

## Error handling

Follow the repo-wide [error handling guide](error-handling.md). For frontend code, unexpected render/runtime failures should bubble to browser/global error handling. Use local error UI only for expected, recoverable outcomes that are part of a feature contract, such as validation failures, failed REST mutations, or WS command errors.

## Store layer

All server communication — fetching, WebSocket event handling, polling, and invalidation — lives in a centralized store layer. Views read state and render; they never fetch data or decide when to refetch.

Store/component boundary:

- **Stores own business logic** — domain mutations, persistence, server synchronization, derived selectors, validation that affects saved state, async flags/errors, and cross-component state.
- **Components own view state** — open/closed toggles, active tabs, drafts, hover/focus, scroll/measurement, and other transient state that only affects presentation.
- **Promote deliberately** — if state must survive remounts, be shared across routes/components, or drive server work, move it into a store; otherwise keep it local or extract it to a reactive controller.

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
                           │  Owns app/domain state │
                           │  and coordinates        │
                           │  sub-stores             │
                           └───────────┬────────────┘
                                       │ subscribe()
                    ┌──────────┬───────┴───────┬──────────┐
                    ▼          ▼               ▼          ▼
             session-sidebar  chat-panel   diff-panel  project-sidebar
                              (components/)
```

### Store map

Keep store descriptions at the ownership-boundary level. Avoid listing every endpoint, event, or feature a store currently supports; those details belong in code, tests, or feature-specific docs when they affect behavior.

- **AppStore** (`models/stores/app-store.ts`) — Top-level orchestration for route-derived app state, WebSocket/reconnect side effects, and sub-store coordination. Components should prefer semantic AppStore/sub-store methods over reaching into lower-level internals.
- **DiffStore** (`models/stores/diff-store.ts`) — Git diff domain state and mutations, including polling and expansion. Rendering concerns such as syntax highlighting stay in controllers/components.
- **SessionCache** (`models/stores/session-cache.ts`) — Canonical client cache for server-provided session metadata. Stores derive session/activity views from it rather than duplicating complete session records.
- **ConversationsStore** (`models/stores/conversations-store.ts`) — Keyed per-session conversation presentation state that must survive route changes or missed streaming events. Session running/activity state remains derived from `SessionCache`.
- **ProjectsStore / ProjectStore** (`models/stores/projects-store.ts`, `models/stores/project-store.ts`) — Project/task/session list ownership and project-scoped mutations. Activity and session metadata are derived from `SessionCache` instead of stored redundantly.
- **QuickOpenStore** (`models/stores/quick-open-store.ts`) — Shared quick-open data, filtering, and recency state. Overlay open/closed state remains component-local.
- **FileBrowserStore** (`models/stores/file-browser-store.ts`) — Shared file browser data and file-content loading. Viewer overlay state remains component-local.
- **ModelRegistryStore** (`models/stores/model-registry-store.ts`) — Provider/model registry data and derived selectors. Settings UI uses the instance owned by `SettingsStore`; other features may own their own registry instance when their data lifecycle is independent.
- **SettingsStore** (`models/stores/settings-store.ts`) — Persisted settings, auth/OAuth mutations, settings-panel model registry loading, and successful settings-change callbacks. Settings components keep only form/view-local state such as drafts and overlay visibility; `components/settings/panel.ts` subscribes to store change callbacks and owns success toast copy. Setting declarations in the panel define each setting's persisted keys, visibility, and render function; the panel filters visible declarations and passes their keys to `SettingsStore.loadSettings(...)`.

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

Thin WebSocket wrapper for receiving server events and sending session-scoped commands. It exposes callbacks only; it does not decide how events affect UI state.

`AppStore` is the store-layer consumer of WebSocket connection/event hooks. It translates events into store mutations, refreshes, and conversation updates. Components never listen to WS events directly.

### Activity indicator semantics

Session activity is server-authoritative and enters the frontend through `SessionCache`. Project/session views derive activity indicators from cached session metadata rather than raw runtime events or duplicated component state.

Running indicators remain visible while the agent loop is active. Finished indicators represent unread completed work and are cleared when the session is viewed. Reconnect/resume flows reconcile from the server snapshot instead of trusting missed client events.

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

- **Business logic in stores, view state in components** — Stores decide what data means and how it changes; components keep transient UI state needed to render and interact.
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
